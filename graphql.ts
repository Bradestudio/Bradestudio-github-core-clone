// graphql.ts — a small, dependency-free GraphQL executor for the forge.
//
// Supports the subset the sealed suite uses: queries, mutations, variables,
// fragments (named and inline), @skip/@include, __typename and __type
// introspection. Unknown fields produce errors in the data (HTTP 200);
// a document that cannot be parsed at all is a 400.

import type { Issue, Pull, Repo } from './store.ts';
import { store, nowIso } from './store.ts';
import {
  decodeNodeId,
  findRepoByDbId,
  issueNodeId,
  mergePullRequest,
  pullMergeable,
  pullNodeId,
  repoNodeId,
  commentNodeId,
  diffTrees,
} from './api.ts';
import { parseCommit } from './git.ts';

// -------------------------------------------------------------------------------------------
// lexer / parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

function lex(source: string): Array<{ type: string; value: string }> {
  const tokens: Array<{ type: string; value: string }> = [];
  let i = 0;
  const push = (type: string, value: string): void => {
    tokens.push({ type, value });
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push('...', '...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      push(ch, ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Triple-quoted block string.
      if (source.slice(i, i + 3) === '"""') {
        let j = i + 3;
        while (j < source.length && source.slice(j, j + 3) !== '"""') j += 1;
        push('String', source.slice(i + 3, j));
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      push('String', value);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let sawDot = false;
      let sawExp = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j]!)) {
        if (source[j] === '.') sawDot = true;
        j += 1;
      }
      if (j < source.length && (source[j] === 'e' || source[j] === 'E')) {
        sawExp = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      push(sawDot || sawExp ? 'Float' : 'Int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      push('Name', source.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  push('EOF', '');
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ type: string; value: string }>;

  constructor(tokens: Array<{ type: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { type: string; value: string } {
    return this.tokens[this.pos]!;
  }

  private next(): { type: string; value: string } {
    return this.tokens[this.pos++]!;
  }

  private expect(type: string): { type: string; value: string } {
    const token = this.next();
    if (token.type !== type) throw new ParseError(`Expected ${type}, got ${token.type} (${token.value})`);
    return token;
  }

  private match(type: string): boolean {
    if (this.peek().type === type) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().type !== 'EOF') {
      if (this.peek().type === 'Name' && this.peek().value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseFragment(): FragmentNode {
    this.expect('Name'); // fragment
    const name = this.expect('Name').value;
    this.expect('Name'); // on
    const typeCondition = this.expect('Name').value;
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { name, typeCondition, directives, selectionSet };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.peek().type === 'Name' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      if (this.peek().type === 'Name') name = this.next().value;
    } else if (this.peek().type === 'Name' && this.peek().value === 'subscription') {
      throw new ParseError('Subscriptions are not supported');
    }
    const variableDefinitions = this.parseVariableDefinitions();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, directives, selectionSet };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.match('(')) return defs;
    while (!this.match(')')) {
      this.expect('$');
      const name = this.expect('Name').value;
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.match('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.match('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('Name');
    }
    this.match('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().type === '@') {
      this.next();
      const name = this.expect('Name').value;
      const args = this.parseArguments();
      directives.push({ name, arguments: args });
    }
    return directives;
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.match('(')) return args;
    while (!this.match(')')) {
      const name = this.expect('Name').value;
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.type) {
      case '$':
        return { kind: 'Variable', name: this.expect('Name').value };
      case 'Int':
        return { kind: 'Int', value: Number(token.value) };
      case 'Float':
        return { kind: 'Float', value: Number(token.value) };
      case 'String':
        return { kind: 'String', value: token.value };
      case 'Name':
        if (token.value === 'true') return { kind: 'Boolean', value: true };
        if (token.value === 'false') return { kind: 'Boolean', value: false };
        if (token.value === 'null') return { kind: 'Null' };
        return { kind: 'Enum', value: token.value };
      case '[': {
        const values: ValueNode[] = [];
        while (!this.match(']')) values.push(this.parseValue());
        return { kind: 'List', values };
      }
      case '{': {
        const fields: Array<{ name: string; value: ValueNode }> = [];
        while (!this.match('}')) {
          const name = this.expect('Name').value;
          this.expect(':');
          fields.push({ name, value: this.parseValue() });
        }
        return { kind: 'Object', fields };
      }
      default:
        throw new ParseError(`Unexpected token ${token.type} (${token.value}) as a value`);
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.match('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().type === '...') {
      this.next();
      if (this.peek().type === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('Name').value;
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'InlineFragment', typeCondition, directives, selectionSet };
      }
      if (this.peek().type === 'Name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'FragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'InlineFragment', typeCondition: null, directives, selectionSet };
    }
    const first = this.expect('Name').value;
    let alias: string | null = null;
    let name = first;
    if (this.peek().type === ':') {
      this.next();
      alias = first;
      name = this.expect('Name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.peek().type === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, arguments: args, directives, selectionSet };
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// value resolution
// -------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromNode(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
      return node.value;
    case 'String':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => valueFromNode(value, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsFromNodes(nodes: ArgumentNode[], variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of nodes) out[node.name] = valueFromNode(node.value, variables);
  return out;
}

function directiveValue(directives: DirectiveNode[], name: string, variables: Variables): boolean | null {
  for (const directive of directives) {
    if (directive.name !== name) continue;
    const args = argsFromNodes(directive.arguments, variables);
    if (typeof args.if === 'boolean') return args.if;
  }
  return null;
}

function shouldInclude(directives: DirectiveNode[], variables: Variables): boolean {
  const skip = directiveValue(directives, 'skip', variables);
  if (skip === true) return false;
  const include = directiveValue(directives, 'include', variables);
  if (include === false) return false;
  return true;
}

// -------------------------------------------------------------------------------------------
// typed values and resolvers
// -------------------------------------------------------------------------------------------

type TypedValue =
  | { __kind: 'Query' }
  | { __kind: 'Mutation' }
  | { __kind: 'User'; viewer: boolean; login: string }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'PullRequest'; repo: Repo; pull: Pull }
  | { __kind: 'Ref'; name: string }
  | { __kind: 'IssueConnection'; repo: Repo; all: Issue[]; page: Issue[] }
  | { __kind: 'PullRequestConnection'; repo: Repo; all: Pull[]; page: Pull[] }
  | { __kind: 'FileConnection'; repo: Repo; files: Array<{ filename: string }> }
  | { __kind: 'IssueEdge'; repo: Repo; issue: Issue; cursor: string }
  | { __kind: 'PullRequestEdge'; repo: Repo; pull: Pull; cursor: string }
  | { __kind: 'FileEdge'; filename: string; cursor: string }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __kind: 'Comment'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } }
  | { __kind: 'CommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } }
  | { __kind: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __kind: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __kind: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __kind: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __kind: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string; updatedAt: string } }
  | { __kind: 'Type'; type: IntrospectionType };

interface IntrospectionType {
  name: string;
  kind: 'OBJECT' | 'ENUM';
  fields: Array<{ name: string }>;
  enumValues: Array<{ name: string }>;
}

const INTROSPECTION: Record<string, IntrospectionType> = {
  Issue: {
    name: 'Issue',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'number' },
      { name: 'title' },
      { name: 'state' },
      { name: 'body' },
      { name: 'createdAt' },
      { name: 'updatedAt' },
      { name: 'repository' },
      { name: 'comments' },
    ],
    enumValues: [],
  },
  PullRequest: {
    name: 'PullRequest',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'number' },
      { name: 'title' },
      { name: 'body' },
      { name: 'state' },
      { name: 'merged' },
      { name: 'mergeable' },
      { name: 'headRefName' },
      { name: 'baseRefName' },
      { name: 'files' },
      { name: 'createdAt' },
      { name: 'updatedAt' },
    ],
    enumValues: [],
  },
  Repository: {
    name: 'Repository',
    kind: 'OBJECT',
    fields: [
      { name: 'id' },
      { name: 'databaseId' },
      { name: 'name' },
      { name: 'nameWithOwner' },
      { name: 'owner' },
      { name: 'defaultBranchRef' },
      { name: 'viewerPermission' },
      { name: 'hasIssuesEnabled' },
      { name: 'issue' },
      { name: 'issues' },
      { name: 'pullRequests' },
      { name: 'pullRequest' },
      { name: 'createdAt' },
    ],
    enumValues: [],
  },
  SearchType: {
    name: 'SearchType',
    kind: 'ENUM',
    fields: [],
    enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }],
  },
};

function encodeCursor(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): string | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

class Executor {
  private errors: GqlError[] = [];
  private readonly document: DocumentNode;
  private readonly variables: Variables;

  constructor(document: DocumentNode, variables: Variables) {
    this.document = document;
    this.variables = variables;
  }

  executeOperation(operation: OperationNode): { data: Record<string, unknown>; errors?: GqlError[] } {
    this.errors = [];
    const root: TypedValue = operation.operation === 'mutation' ? { __kind: 'Mutation' } : { __kind: 'Query' };
    const data = this.executeSelectionSet(operation.selectionSet, root, root.__kind, []);
    const result: { data: Record<string, unknown>; errors?: GqlError[] } = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private executeSelectionSet(
    selections: SelectionNode[],
    parent: TypedValue,
    parentType: string,
    path: Array<string | number>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'FragmentSpread') {
        if (!shouldInclude(selection.directives, this.variables)) continue;
        const fragment = this.document.fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}"`, path });
          continue;
        }
        if (fragment.typeCondition !== parentType) continue;
        Object.assign(out, this.executeSelectionSet(fragment.selectionSet, parent, parentType, path));
        continue;
      }
      if (selection.kind === 'InlineFragment') {
        if (!shouldInclude(selection.directives, this.variables)) continue;
        if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
        Object.assign(out, this.executeSelectionSet(selection.selectionSet, parent, parentType, path));
        continue;
      }
      if (!shouldInclude(selection.directives, this.variables)) continue;
      const key = selection.alias ?? selection.name;
      out[key] = this.resolveField(selection, parent, parentType, [...path, key]);
    }
    return out;
  }

  private resolveField(
    field: FieldNode,
    parent: TypedValue,
    parentType: string,
    path: Array<string | number>,
  ): unknown {
    const args = argsFromNodes(field.arguments, this.variables);
    if (field.name === '__typename') return parentType;
    const result = this.fieldValue(field.name, args, parent, parentType, path);
    if (result === undefined) {
      const message =
        parent.__kind === 'User' && parent.viewer
          ? `noSuchFieldOnViewer: field "${field.name}" does not exist on Viewer`
          : `Field "${field.name}" doesn't exist on type "${parentType}"`;
      this.errors.push({ message, path });
      return null;
    }
    if (result === null) return null;
    if (field.selectionSet === null) return result;
    if (typeof result === 'object' && result !== null && '__kind' in result) {
      const typed = result as TypedValue;
      const childType = typed.__kind;
      return this.executeSelectionSet(field.selectionSet, typed, childType, path);
    }
    if (Array.isArray(result)) {
      return result.map((entry, index) => {
        if (entry !== null && typeof entry === 'object' && '__kind' in entry) {
          const typed = entry as TypedValue;
          return this.executeSelectionSet(field.selectionSet, typed, typed.__kind, [...path, index]);
        }
        return entry;
      });
    }
    return result;
  }

  private fieldValue(
    name: string,
    args: Record<string, unknown>,
    parent: TypedValue,
    parentType: string,
    path: Array<string | number>,
  ): unknown {
    switch (parent.__kind) {
      case 'Query':
        return this.queryField(name, args);
      case 'Mutation':
        return this.mutationField(name, args);
      case 'User':
        if (name === 'login') return parent.login;
        if (name === 'id') return 1;
        return undefined;
      case 'Repository':
        return this.repositoryField(name, args, parent.repo);
      case 'Issue':
        return this.issueField(name, args, parent.repo, parent.issue);
      case 'PullRequest':
        return this.pullField(name, args, parent.repo, parent.pull);
      case 'Ref':
        if (name === 'name') return parent.name;
        return undefined;
      case 'IssueConnection':
        return this.issueConnectionField(name, parent);
      case 'PullRequestConnection':
        return this.pullConnectionField(name, parent);
      case 'FileConnection':
        return this.fileConnectionField(name, parent);
      case 'IssueEdge':
        if (name === 'node') return { __kind: 'Issue', repo: parent.repo, issue: parent.issue } as TypedValue;
        if (name === 'cursor') return parent.cursor;
        return undefined;
      case 'PullRequestEdge':
        if (name === 'node') return { __kind: 'PullRequest', repo: parent.repo, pull: parent.pull } as TypedValue;
        if (name === 'cursor') return parent.cursor;
        return undefined;
      case 'FileEdge':
        if (name === 'node') return { path: parent.filename };
        if (name === 'cursor') return parent.cursor;
        return undefined;
      case 'PageInfo':
        if (name === 'hasNextPage') return parent.hasNextPage;
        if (name === 'endCursor') return parent.endCursor;
        if (name === 'hasPreviousPage') return false;
        if (name === 'startCursor') return null;
        return undefined;
      case 'Comment':
        if (name === 'id') return commentNodeId(parent.repo, parent.issue, parent.comment.id);
        if (name === 'body') return parent.comment.body;
        if (name === 'createdAt') return parent.comment.createdAt;
        if (name === 'updatedAt') return parent.comment.updatedAt;
        return undefined;
      case 'CommentEdge':
        if (name === 'node') {
          return { __kind: 'Comment', repo: parent.repo, issue: parent.issue, comment: parent.comment } as TypedValue;
        }
        if (name === 'cursor') return encodeCursor(`comment:${parent.repo.id}:${parent.issue.number}:${parent.comment.id}`);
        return undefined;
      case 'CreateIssuePayload':
        if (name === 'issue') return { __kind: 'Issue', repo: parent.repo, issue: parent.issue } as TypedValue;
        return undefined;
      case 'CloseIssuePayload':
        if (name === 'issue') return { __kind: 'Issue', repo: parent.repo, issue: parent.issue } as TypedValue;
        return undefined;
      case 'CreatePullRequestPayload':
        if (name === 'pullRequest') return { __kind: 'PullRequest', repo: parent.repo, pull: parent.pull } as TypedValue;
        return undefined;
      case 'MergePullRequestPayload':
        if (name === 'pullRequest') return { __kind: 'PullRequest', repo: parent.repo, pull: parent.pull } as TypedValue;
        return undefined;
      case 'AddCommentPayload':
        if (name === 'commentEdge') {
          return { __kind: 'CommentEdge', repo: parent.repo, issue: parent.issue, comment: parent.comment } as TypedValue;
        }
        if (name === 'comment') {
          return { __kind: 'Comment', repo: parent.repo, issue: parent.issue, comment: parent.comment } as TypedValue;
        }
        return undefined;
      case 'Type':
        if (name === 'name') return parent.type.name;
        if (name === 'kind') return parent.type.kind;
        if (name === 'fields') return parent.type.fields;
        if (name === 'enumValues') return parent.type.enumValues;
        return undefined;
      default:
        return undefined;
    }
  }

  private queryField(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') {
      return { __kind: 'User', viewer: true, login: store.viewerLogin() } as TypedValue;
    }
    if (name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = store.findRepo(owner, repoName);
      if (repo === null) return null;
      return { __kind: 'Repository', repo } as TypedValue;
    }
    if (name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeNodeId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repo = findRepoByDbId(decoded.repoId);
        if (repo === null) return null;
        return { __kind: 'Repository', repo } as TypedValue;
      }
      if (decoded.kind === 'issue' && decoded.number !== undefined) {
        const repo = findRepoByDbId(decoded.repoId);
        const issue = repo?.issueByNumber.get(decoded.number);
        if (repo === undefined || repo === null || issue === undefined) return null;
        return { __kind: 'Issue', repo, issue } as TypedValue;
      }
      if (decoded.kind === 'pull' && decoded.number !== undefined) {
        const repo = findRepoByDbId(decoded.repoId);
        const pull = repo?.pullByNumber.get(decoded.number);
        if (repo === undefined || repo === null || pull === undefined) return null;
        return { __kind: 'PullRequest', repo, pull } as TypedValue;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = typeof args.name === 'string' ? args.name : '';
      const type = INTROSPECTION[typeName];
      if (type === undefined) return null;
      return { __kind: 'Type', type } as TypedValue;
    }
    return undefined;
  }

  private mutationField(name: string, args: Record<string, unknown>): unknown {
    const input = (args.input !== null && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeNodeId(repositoryId);
      const repo = decoded !== null && decoded.kind === 'repo' ? findRepoByDbId(decoded.repoId) : null;
      if (repo === null) {
        this.errors.push({ message: 'Repository not found' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, bodyText, []);
      return { __kind: 'CreateIssuePayload', repo, issue } as TypedValue;
    }
    if (name === 'closeIssue') {
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeNodeId(issueId);
      if (decoded === null || decoded.kind !== 'issue' || decoded.number === undefined) {
        this.errors.push({ message: 'Issue not found' });
        return null;
      }
      const repo = findRepoByDbId(decoded.repoId);
      const issue = repo?.issueByNumber.get(decoded.number);
      if (repo === null || repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Issue not found' });
        return null;
      }
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      return { __kind: 'CloseIssuePayload', repo, issue } as TypedValue;
    }
    if (name === 'createPullRequest') {
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeNodeId(repositoryId);
      const repo = decoded !== null && decoded.kind === 'repo' ? findRepoByDbId(decoded.repoId) : null;
      if (repo === null) {
        this.errors.push({ message: 'Repository not found' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        this.errors.push({ message: 'Head or base branch does not exist' });
        return null;
      }
      const open = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (open !== undefined) {
        this.errors.push({ message: 'A pull request already exists for this head and base' });
        return null;
      }
      const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
      return { __kind: 'CreatePullRequestPayload', repo, pull } as TypedValue;
    }
    if (name === 'mergePullRequest') {
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeNodeId(pullRequestId);
      if (decoded === null || decoded.kind !== 'pull' || decoded.number === undefined) {
        this.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const repo = findRepoByDbId(decoded.repoId);
      const pull = repo?.pullByNumber.get(decoded.number);
      if (repo === null || repo === undefined || pull === undefined) {
        this.errors.push({ message: 'Pull request not found' });
        return null;
      }
      if (pull.state !== 'open') {
        this.errors.push({ message: 'Pull request is already closed' });
        return null;
      }
      const mergeSha = mergePullRequest(repo, pull);
      if (mergeSha === null) {
        this.errors.push({ message: 'Merge conflict' });
        return null;
      }
      return { __kind: 'MergePullRequestPayload', repo, pull } as TypedValue;
    }
    if (name === 'addComment') {
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const decoded = decodeNodeId(subjectId);
      if (decoded === null || decoded.kind !== 'issue' || decoded.number === undefined) {
        this.errors.push({ message: 'Subject not found' });
        return null;
      }
      const repo = findRepoByDbId(decoded.repoId);
      const issue = repo?.issueByNumber.get(decoded.number);
      if (repo === null || repo === undefined || issue === undefined) {
        this.errors.push({ message: 'Subject not found' });
        return null;
      }
      const text = typeof input.body === 'string' ? input.body : '';
      const stamp = nowIso();
      const comment = { id: repo.nextComment, body: text, createdAt: stamp, updatedAt: stamp };
      repo.nextComment += 1;
      issue.comments.push(comment);
      return { __kind: 'AddCommentPayload', repo, issue, comment } as TypedValue;
    }
    return undefined;
  }

  private repositoryField(name: string, args: Record<string, unknown>, repo: Repo): unknown {
    switch (name) {
      case 'id':
        return repoNodeId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner ?? store.viewerLogin()}/${repo.name}`;
      case 'owner':
        return { __kind: 'User', viewer: false, login: repo.owner ?? store.viewerLogin() } as TypedValue;
      case 'defaultBranchRef':
        return { __kind: 'Ref', name: repo.defaultBranch } as TypedValue;
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'createdAt':
        return new Date(1_700_000_000_000 + repo.createdSeq * 1_000).toISOString();
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : Number(args.number);
        const issue = repo.issueByNumber.get(number);
        if (issue === undefined) return null;
        return { __kind: 'Issue', repo, issue } as TypedValue;
      }
      case 'issues': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const after = typeof args.after === 'string' ? args.after : null;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy !== null && typeof args.orderBy === 'object' ? args.orderBy : {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
        let list = [...repo.issues];
        if (states !== null) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        const afterNumber = after === null ? null : Number(decodeCursor(after)?.split(':')[2] ?? NaN);
        let start = 0;
        if (afterNumber !== null && Number.isFinite(afterNumber)) {
          const index = list.findIndex((issue) => issue.number === afterNumber);
          start = index >= 0 ? index + 1 : 0;
        }
        const page = list.slice(start, start + first);
        return { __kind: 'IssueConnection', repo, all: list, page } as TypedValue;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const after = typeof args.after === 'string' ? args.after : null;
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const afterNumber = after === null ? null : Number(decodeCursor(after)?.split(':')[2] ?? NaN);
        let start = 0;
        if (afterNumber !== null && Number.isFinite(afterNumber)) {
          const index = list.findIndex((pull) => pull.number === afterNumber);
          start = index >= 0 ? index + 1 : 0;
        }
        const page = list.slice(start, start + first);
        return { __kind: 'PullRequestConnection', repo, all: list, page } as TypedValue;
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : Number(args.number);
        const pull = repo.pullByNumber.get(number);
        if (pull === undefined) return null;
        return { __kind: 'PullRequest', repo, pull } as TypedValue;
      }
      default:
        return undefined;
    }
  }

  private issueField(name: string, args: Record<string, unknown>, repo: Repo, issue: Issue): unknown {
    switch (name) {
      case 'id':
        return issueNodeId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'repository':
        return { __kind: 'Repository', repo } as TypedValue;
      case 'comments': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const page = issue.comments.slice(0, first);
        return page.map((comment) => ({ __kind: 'Comment', repo, issue, comment }) as TypedValue);
      }
      default:
        return undefined;
    }
  }

  private pullField(name: string, args: Record<string, unknown>, repo: Repo, pull: Pull): unknown {
    switch (name) {
      case 'id':
        return pullNodeId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const after = typeof args.after === 'string' ? args.after : null;
        const baseObject = repo.objects.get(pull.baseSha);
        const headObject = repo.objects.get(pull.headSha);
        if (baseObject === undefined || headObject === undefined) return { __kind: 'FileConnection', repo, files: [] } as TypedValue;
        if (baseObject.type !== 'commit' || headObject.type !== 'commit') {
          return { __kind: 'FileConnection', repo, files: [] } as TypedValue;
        }
        const files = diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
        const afterPath = after === null ? null : decodeCursor(after)?.slice('file:'.length) ?? null;
        let start = 0;
        if (afterPath !== null) {
          const index = files.findIndex((file) => file.filename === afterPath);
          start = index >= 0 ? index + 1 : 0;
        }
        const page = files.slice(start, start + first);
        return { __kind: 'FileConnection', repo, files: page } as TypedValue;
      }
      default:
        return undefined;
    }
  }

  private issueConnectionField(name: string, parent: { __kind: 'IssueConnection'; repo: Repo; all: Issue[]; page: Issue[] }): unknown {
    switch (name) {
      case 'nodes':
        return parent.page.map((issue) => ({ __kind: 'Issue', repo: parent.repo, issue }) as TypedValue);
      case 'edges':
        return parent.page.map(
          (issue) =>
            ({
              __kind: 'IssueEdge',
              repo: parent.repo,
              issue,
              cursor: encodeCursor(`issue:${parent.repo.id}:${issue.number}`),
            }) as TypedValue,
        );
      case 'pageInfo': {
        const last = parent.page[parent.page.length - 1];
        const hasNextPage = last !== undefined && parent.all.indexOf(last) < parent.all.length - 1;
        return {
          __kind: 'PageInfo',
          hasNextPage,
          endCursor: last === undefined ? null : encodeCursor(`issue:${parent.repo.id}:${last.number}`),
        } as TypedValue;
      }
      case 'totalCount':
        return parent.all.length;
      default:
        return undefined;
    }
  }

  private pullConnectionField(name: string, parent: { __kind: 'PullRequestConnection'; repo: Repo; all: Pull[]; page: Pull[] }): unknown {
    switch (name) {
      case 'nodes':
        return parent.page.map((pull) => ({ __kind: 'PullRequest', repo: parent.repo, pull }) as TypedValue);
      case 'edges':
        return parent.page.map(
          (pull) =>
            ({
              __kind: 'PullRequestEdge',
              repo: parent.repo,
              pull,
              cursor: encodeCursor(`pull:${parent.repo.id}:${pull.number}`),
            }) as TypedValue,
        );
      case 'pageInfo': {
        const last = parent.page[parent.page.length - 1];
        const hasNextPage = last !== undefined && parent.all.indexOf(last) < parent.all.length - 1;
        return {
          __kind: 'PageInfo',
          hasNextPage,
          endCursor: last === undefined ? null : encodeCursor(`pull:${parent.repo.id}:${last.number}`),
        } as TypedValue;
      }
      case 'totalCount':
        return parent.all.length;
      default:
        return undefined;
    }
  }

  private fileConnectionField(name: string, parent: { __kind: 'FileConnection'; repo: Repo; files: Array<{ filename: string }> }): unknown {
    switch (name) {
      case 'nodes':
        return parent.files.map((file) => ({ path: file.filename }));
      case 'edges':
        return parent.files.map(
          (file) =>
            ({ __kind: 'FileEdge', filename: file.filename, cursor: encodeCursor(`file:${file.filename}`) }) as TypedValue,
        );
      case 'pageInfo': {
        const last = parent.files[parent.files.length - 1];
        return {
          __kind: 'PageInfo',
          hasNextPage: false,
          endCursor: last === undefined ? null : encodeCursor(`file:${last.filename}`),
        } as TypedValue;
      }
      case 'totalCount':
        return parent.files.length;
      default:
        return undefined;
    }
  }
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphqlResult {
  status: number;
  json: unknown;
}

/** Execute one {query, variables, operationName} body. */
function executeOne(body: unknown): GraphqlResult {
  const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const query = typeof input.query === 'string' ? input.query : '';
  const variables = (input.variables !== null && typeof input.variables === 'object' ? input.variables : {}) as Variables;
  if (query === '') return { status: 400, json: { errors: [{ message: 'Must provide query string.' }] } };
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { status: 400, json: { errors: [{ message: (err as Error).message }] } };
  }
  if (document.operations.length === 0) {
    return { status: 400, json: { errors: [{ message: 'Must provide an operation.' }] } };
  }
  const operationName = typeof input.operationName === 'string' ? input.operationName : null;
  let operations = document.operations;
  if (operationName !== null) {
    operations = operations.filter((operation) => operation.name === operationName);
    if (operations.length === 0) {
      return { status: 400, json: { errors: [{ message: `Unknown operation named "${operationName}".` }] } };
    }
  }
  const results = operations.map((operation) => {
    const executor = new Executor(document, variables);
    return executor.executeOperation(operation);
  });
  if (results.length === 1) return { status: 200, json: results[0] };
  return { status: 200, json: results };
}

export function handleGraphql(body: unknown): GraphqlResult {
  // GitHub-style operation batching: a JSON array of operation bodies is
  // answered by a JSON array of results, in the same order.
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(entry).json);
    return { status: 200, json: results };
  }
  return executeOne(body);
}
