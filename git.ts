// git.ts — the git object model, packfiles, pkt-lines and smart HTTP.
//
// Everything here is stdlib only (node:crypto, node:zlib). Packs carry plain
// objects (no deltas); the reader also resolves OFS_DELTA / REF_DELTA so a
// delta-carrying push cannot corrupt the store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';

export const AGENT = 'forge/1.0.0';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function buildCommit(o: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${o.timestamp} +0000`;
  let text = `tree ${o.tree}\n`;
  for (const parent of o.parents) text += `parent ${parent}\n`;
  text += `author ${o.author} ${stamp}\n`;
  text += `committer ${o.committer} ${stamp}\n`;
  text += `\n${o.message}`;
  return Buffer.from(text, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${type}`);
  }
  return { object, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message };
}

/** Peel an annotated tag (recursively) to the commit it names; null when not a tag chain. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode every pkt-line in `buffer`; throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line length is not hex');
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/**
 * Decode pkt-lines from the start of `buffer` until the first flush packet;
 * returns the packets and the byte offset just past the flush (the rest of the
 * buffer is raw data, e.g. a packfile).
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: Pkt[]; restOffset: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line length is not hex');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, restOffset: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  throw new Error('pkt-line stream ended without a flush');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = zlibInflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return trailer === computed;
}

/** Read a packfile (v2/v3), resolving plain objects and deltas. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buffer = pack;
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  if (!verifyPackChecksum(buffer)) throw new Error('pack trailer does not match its bytes');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  // Fast path: a pack with no delta entries needs no resolution machinery —
  // a plain object's oid is just its type + data hash, as below. Behaviour
  // is identical to the general path for such packs (same oids, same order,
  // same first-wins dedup); delta packs still take the general path.
  let hasDelta = false;
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      hasDelta = true;
      break;
    }
  }
  if (!hasDelta) {
    const plain = new Map<string, GitObject>();
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode]!;
      const oid = hashObject(type, entry.data);
      if (!plain.has(oid)) plain.set(oid, { type, data: entry.data });
    }
    return plain;
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as Raw & { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as Raw & { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Write a packfile (v2, plain objects, no deltas) from a list of objects. */
export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    // varint: low 4 bits in the first byte with the type, then 7 bits per byte.
    const sizeBytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeCode << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    sizeBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// graph walks and tree paths
// -------------------------------------------------------------------------------------------

export interface ReachableOptions {
  /** Limit commit generations from the tips (1 = the tips only). */
  depth?: number;
  /** Commits whose parents are not descended into (shallow boundaries). */
  stopAt?: ReadonlySet<string>;
}

/**
 * The closure of `tips`: every commit (within `depth`), its tree and blobs,
 * and tag targets. When `depth` is set, a commit at distance `depth` is a
 * shallow boundary: its tree and blobs are included, its parents are not.
 */
export function collectReachable(repo: Repo, tips: Iterable<string>, options: ReachableOptions = {}): Set<string> {
  const out = new Set<string>();
  const depth = options.depth;
  const stopAt = options.stopAt;
  // commit queue: [oid, distance]
  const queue: Array<[string, number]> = [];
  for (const tip of tips) {
    if (tip === ZERO_OID) continue;
    queue.push([tip, 0]);
  }
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const [oid, distance] = queue.pop()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      out.add(oid);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined) {
        if (targetObject.type === 'commit') queue.push([target, distance]);
        else if (targetObject.type === 'tree') collectTree(repo, target, out);
        else out.add(target);
      }
      continue;
    }
    if (object.type !== 'commit') {
      // A tip that is a tree or blob (unusual for fetch): include it whole.
      if (object.type === 'tree') collectTree(repo, oid, out);
      else out.add(oid);
      continue;
    }
    out.add(oid);
    const commit = parseCommit(object.data);
    collectTree(repo, commit.tree, out);
    if (depth !== undefined && distance + 1 >= depth) continue;
    if (stopAt !== undefined && stopAt.has(oid)) continue;
    for (const parent of commit.parents) queue.push([parent, distance + 1]);
  }
  return out;
}

function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') {
      if (object !== undefined) out.add(oid);
      continue;
    }
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/** True when `ancestor` is reachable from `descendant` by parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The blob oid at `segments` under the tree, or null. */
export function treeLookup(repo: Repo, treeOid: string, segments: string[]): string | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The subtree oid at `segments` under the tree, or null when it is not a directory. */
export function treeDirLookup(repo: Repo, treeOid: string, segments: string[]): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/**
 * A new root tree with `segments` set to `blobOid` (or deleted when null),
 * creating intermediate trees as needed. Returns the new root tree oid.
 */
export function treeSetPath(repo: Repo, rootTreeOid: string | null, segments: string[], blobOid: string | null): string {
  if (segments.length === 0) throw new Error('empty path');
  const set = (treeOid: string | null, depth: number): string => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const name = segments[depth]!;
    const existing = entries.findIndex((entry) => entry.name === name);
    if (depth === segments.length - 1) {
      if (blobOid === null) {
        if (existing >= 0) entries.splice(existing, 1);
      } else if (existing >= 0) {
        entries[existing] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = existing >= 0 && entries[existing]!.mode === '40000' ? entries[existing]!.oid : null;
      const next = set(childOid, depth + 1);
      const nextObject = repo.objects.get(next);
      const empty = nextObject !== undefined && nextObject.type === 'tree' && parseTree(nextObject.data).length === 0;
      if (empty) {
        if (existing >= 0) entries.splice(existing, 1);
      } else if (existing >= 0) {
        entries[existing] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return set(rootTreeOid, 0);
}

// -------------------------------------------------------------------------------------------
// fetch computation
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Oids to send, in a deterministic order. */
  send: string[];
  /** New shallow boundaries (commits at the depth cutoff). */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
}

/** Shortest parent-distance from any of `starts` to every reachable commit. */
export function distancesFrom(repo: Repo, starts: string[]): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = starts.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (distances.has(current.oid)) continue;
    distances.set(current.oid, current.distance);
    const object = repo.objects.get(current.oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) queue.push({ oid: parent, distance: current.distance + 1 });
    }
  }
  return distances;
}

/**
 * Plan a v2/v0 fetch: what the client does not hold, and the shallow-info.
 * `haves` are commits the client holds; `clientShallow` are its shallow
 * boundaries (their parents are NOT held). `depth` is the requested deepen:
 * absolute from the wants, unless `deepenRelative` is set, in which case it
 * is counted from each old shallow boundary (real git's `deepen-relative`).
 */
export function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
  deepenRelative = false,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client holds: the closure of haves, stopping at its boundaries.
  const held = new Set<string>();
  if (haves.length > 0) {
    for (const oid of collectReachable(repo, haves, { stopAt: shallowSet })) held.add(oid);
  }
  // Resolve a relative deepen to an absolute depth from the wants: each old
  // boundary sits at some distance from the wants, and the new boundary is
  // `depth` generations beyond it. The deepest one wins.
  let effectiveDepth = depth;
  if (depth !== null && deepenRelative && clientShallow.length > 0) {
    const distances = distancesFrom(repo, wants);
    let deepest = 0;
    for (const boundary of clientShallow) {
      const distance = distances.get(boundary);
      if (distance !== undefined) deepest = Math.max(deepest, distance + depth + 1);
    }
    if (deepest > 0) effectiveDepth = deepest;
  }
  // What the wants need: the closure of wants, cut at `effectiveDepth` generations.
  const wanted = collectReachable(repo, wants, effectiveDepth === null ? {} : { depth: effectiveDepth });
  const send = [...wanted].filter((oid) => !held.has(oid));
  send.sort();
  // New boundaries: commits at exactly `effectiveDepth` generations from the wants.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (effectiveDepth !== null) {
    const boundary = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<[string, number]> = wants.filter((oid) => oid !== ZERO_OID).map((oid) => [oid, 0] as [string, number]);
    while (queue.length > 0) {
      const [oid, distance] = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (distance + 1 >= effectiveDepth) {
        boundary.add(oid);
        continue;
      }
      for (const parent of parseCommit(object.data).parents) queue.push([parent, distance + 1]);
    }
    for (const oid of [...boundary].sort()) shallow.push(oid);
    for (const old of clientShallow) {
      if (!boundary.has(old) && wanted.has(old)) unshallow.push(old);
    }
    unshallow.sort();
  }
  return { send, shallow, unshallow };
}

/** Build the pack for a fetch plan (plain objects, deterministic order). */
export function packForSend(repo: Repo, send: string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

// -------------------------------------------------------------------------------------------
// smart HTTP
// -------------------------------------------------------------------------------------------

/** Cache of framed fetch responses, keyed by repo + request; cleared on any push. */
const fetchCache = new Map<string, Promise<Buffer>>();

export function clearFetchCache(): void {
  fetchCache.clear();
}

function refLines(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push({ name, oid: repo.refs.get(name)! });
  return out;
}

/** The default branch tip, or ZERO when the repo is unborn. */
export function defaultTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** Build all three advertisements in one pass (shared ref listing). */
function buildAdvertisements(repo: Repo): { version: number; v2: Buffer; v0up: Buffer; v0recv: Buffer } {
  const version = repo.refsVersion;
  const tip = defaultTip(repo);
  const refs = refLines(repo);
  const v2Chunks: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  v2Chunks.push(pktLine('version 2\n'));
  v2Chunks.push(pktLine(`agent=${AGENT}\n`));
  v2Chunks.push(pktLine('ls-refs=unborn\n'));
  v2Chunks.push(pktLine('fetch=shallow\n'));
  v2Chunks.push(pktLine('object-format=sha1\n'));
  v2Chunks.push(PKT_FLUSH);
  const buildV0 = (service: 'git-upload-pack' | 'git-receive-pack'): Buffer => {
    const caps =
      service === 'git-receive-pack'
        ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
        : `side-band-64k ofs-delta multi_ack multi_ack_detailed thin-pack shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
    if (refs.length === 0) {
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      chunks.push(pktLine(`${tip} HEAD\0${caps}\n`));
      for (const ref of refs) chunks.push(pktLine(`${ref.oid} ${ref.name}\n`));
    }
    chunks.push(PKT_FLUSH);
    return Buffer.concat(chunks);
  };
  return { version, v2: Buffer.concat(v2Chunks), v0up: buildV0('git-upload-pack'), v0recv: buildV0('git-receive-pack') };
}

/**
 * The three advertisements, cached per repo at its refsVersion: an
 * advertisement is a pure function of the ref set, so a clone workload's
 * 50 identical ls-refs/advertisement requests share one build. Any ref
 * mutation bumps refsVersion and drops the cache.
 */
function advertisements(repo: Repo): { version: number; v2: Buffer; v0up: Buffer; v0recv: Buffer } {
  const cached = repo.adCache;
  if (cached !== null && cached.version === repo.refsVersion) return cached;
  const built = buildAdvertisements(repo);
  repo.adCache = built;
  return built;
}

/** v2 capability advertisement for git-upload-pack. */
export function advertiseUploadPackV2(repo: Repo): Buffer {
  return advertisements(repo).v2;
}

/** v0 ref advertisement for a service (upload-pack or receive-pack). */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  return service === 'git-receive-pack' ? advertisements(repo).v0recv : advertisements(repo).v0up;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Handle a v2 ls-refs request body; returns the framed response. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0 || !lines[0]!.startsWith('command=ls-refs')) {
    throw new Error('not an ls-refs request');
  }
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  // The answer is a pure function of the ref set + these args: cache it per
  // repo version (a clone workload's 50 identical ls-refs share one build).
  const cacheKey = `${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}${args.unborn ? 'u' : ''}|${args.prefixes.join(',')}`;
  const cached = repo.lsCache;
  if (cached !== null && cached.version === repo.refsVersion && cached.key === cacheKey) return cached.buf;
  const chunks: Buffer[] = [];
  const tip = defaultTip(repo);
  const refs = refLines(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      chunks.push(pktLine(`unborn HEAD${attrs}\n`));
    }
  } else {
    if (keep('HEAD')) {
      const attrs = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      chunks.push(pktLine(`${tip} HEAD${attrs}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
      chunks.push(pktLine(`${line}\n`));
    }
  }
  chunks.push(PKT_FLUSH);
  const out = Buffer.concat(chunks);
  repo.lsCache = { version: repo.refsVersion, key: cacheKey, buf: out };
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
  done: boolean;
  deepenRelative: boolean;
}

/** Parse a v2 fetch request body. */
function parseFetchV2(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0 || !lines[0]!.startsWith('command=fetch')) {
    throw new Error('not a fetch request');
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, done: false, deepenRelative: false };
  let seenDelim = false;
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    } else if (text.startsWith('filter ')) args.filter = text.slice(7).trim();
    else if (text === 'done') args.done = true;
    else if (text === 'deepen-relative') args.deepenRelative = true;
    else if (text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
    else if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    else if (text === 'command=fetch') continue;
    else if (!seenDelim && text === '') seenDelim = true;
  }
  return args;
}

/** Frame a pack as sideband band-1 packets (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const MAX_DATA = 65400;
  const pushBand = (data: Buffer): void => {
    const payload = Buffer.concat([Buffer.from([1]), data]);
    const head = Buffer.alloc(4);
    head.write((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
    chunks.push(Buffer.concat([head, payload]));
  };
  if (pack.length === 0) {
    pushBand(Buffer.alloc(0));
    return chunks;
  }
  for (let offset = 0; offset < pack.length; offset += MAX_DATA) {
    pushBand(pack.subarray(offset, Math.min(pack.length, offset + MAX_DATA)));
  }
  return chunks;
}

/** Async fetch with an in-flight cache so 50 concurrent identical clones share one pack. */
export async function handleFetchV2Async(repo: Repo, body: Buffer): Promise<Buffer> {
  const args = parseFetchV2(body);
  const cacheKey = `${repo.name}|${[...args.wants].sort().join(',')}|${[...args.haves].sort().join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}|${args.done ? 'done' : 'open'}|${args.deepenRelative ? 'rel' : 'abs'}`;
  const existing = fetchCache.get(cacheKey);
  if (existing !== undefined) return existing;
  const promise = (async (): Promise<Buffer> => {
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
    const pack = packForSend(repo, plan.send);
    const chunks: Buffer[] = [];
    // The acknowledgments section is sent only while negotiation is open:
    // the request carries haves but no "done". A client that sent "done"
    // (or no haves at all) skips straight to the packfile and dies on an
    // unexpected "acknowledgments" header. When the section is sent and a
    // pack follows, it carries "ready" before the delimiter.
    if (args.haves.length > 0 && !args.done) {
      chunks.push(pktLine('acknowledgments\n'));
      chunks.push(pktLine('NAK\n'));
      chunks.push(pktLine('ready\n'));
      chunks.push(PKT_DELIM);
    }
    if (args.depth !== null) {
      chunks.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
      chunks.push(PKT_DELIM);
    }
    chunks.push(pktLine('packfile\n'));
    chunks.push(...sidebandPack(pack));
    chunks.push(PKT_FLUSH);
    return Buffer.concat(chunks);
  })();
  fetchCache.set(cacheKey, promise);
  try {
    return await promise;
  } catch (err) {
    fetchCache.delete(cacheKey);
    throw err;
  }
}

/** Handle a v0 fetch request body (want/have/done); returns the framed response. */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    // The first want line may carry capabilities after a NUL (real git) or
    // after a space (the suite's client); the oid is always the first token.
    const raw = packet.payload.toString('utf8').replace(/\n$/, '');
    const text = raw.split('\0')[0]!;
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    } else if (text === 'deepen-relative') deepenRelative = true;
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, deepenRelative);
  const pack = packForSend(repo, plan.send);
  const chunks: Buffer[] = [pktLine('NAK\n')];
  if (depth !== null) {
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  chunks.push(...sidebandPack(pack));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Handle a receive-pack request body; returns the framed sideband report. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let unpackError: string | null = null;
  try {
    const { packets, restOffset } = decodePktLinesUntilFlush(body);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const line = text.replace(/\n$/, '');
      if (!line) continue;
      const parts = line.split(' ');
      if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
        throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    packBytes = body.subarray(restOffset);
  } catch (err) {
    unpackError = (err as Error).message;
    commands = [];
  }

  const report: PushReportEntry[] = [];
  if (unpackError !== null) {
    // A malformed command list: report unpack failure and refuse everything we saw.
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    return framePushReport(false, 'error', report);
  }

  // Unpack first: every object in the pack enters the store, even when a ref
  // update is refused afterwards (real git unpacks before updating refs).
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = (err as Error).message;
      for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      return framePushReport(false, 'error', report);
    }
  }

  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
        changed = true;
      }
      continue;
    }
    // Create or update: the new object must be in the store.
    if (!repo.objects.has(command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
        changed = true;
      }
      continue;
    }
    if (command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const isBranch = command.ref.startsWith('refs/heads/');
    const newObject = repo.objects.get(command.newOid)!;
    if (isBranch && newObject.type === 'commit' && !isAncestor(repo, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
    changed = true;
  }
  if (changed) {
    repo.refsVersion += 1;
    clearFetchCache();
  }
  return framePushReport(true, 'ok', report);
}

/** Frame a report-status stream inside sideband band-1 packets. */
function framePushReport(unpackOk: boolean, unpackDetail: string, report: PushReportEntry[]): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const entry of report) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const inner = Buffer.concat(lines.map((line) => pktLine(line)));
  // Each inner pkt-line rides in its own outer band-1 packet. The inner
  // stream then ends with its own flush (a band-1 packet carrying "0000"):
  // a real git client reads the report through a packet reader that must see
  // a FLUSH, and dies with "the remote end hung up" on EOF without one.
  // The outer stream ends with a bare flush after that.
  const chunks: Buffer[] = [];
  const bandPacket = (data: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from([1]), data]);
    const head = Buffer.alloc(4);
    head.write((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
    return Buffer.concat([head, payload]);
  };
  let offset = 0;
  while (offset < inner.length) {
    const length = parseInt(inner.subarray(offset, offset + 4).toString('ascii'), 16);
    chunks.push(bandPacket(inner.subarray(offset, offset + length)));
    offset += length;
  }
  chunks.push(bandPacket(Buffer.from('0000', 'ascii')));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}
