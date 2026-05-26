import { describe, it, expect } from 'vitest';
import { MongoDBQueryTranslator } from './query-translator.js';
import type { MetadataFilter } from '../../core/types.js';

const translator = new MongoDBQueryTranslator();

const baseParams = {
  projectId: '00000000-0000-0000-0000-000000000001',
  from: new Date('2026-01-01T00:00:00Z'),
  to: new Date('2026-01-02T00:00:00Z'),
};

/** Build a fully-typed MetadataFilter with include_missing defaulting to false */
function mf(o: Omit<MetadataFilter, 'include_missing'> & { include_missing?: boolean }): MetadataFilter {
  return { include_missing: false, ...o } as MetadataFilter;
}

/** Collect the metadata.* clauses produced by the translator. */
function metaClauses(r: { query: Record<string, unknown> }): Record<string, unknown>[] {
  const and = (r.query.$and as Record<string, unknown>[] | undefined) ?? [];
  return and.filter((c) => Object.keys(c).some((k) => k.startsWith('metadata.')));
}

describe('MongoDBQueryTranslator metadata filters', () => {
  it('no filters adds no $and metadata clauses', () => {
    const r = translator.translateQuery(baseParams);
    expect(metaClauses(r as never)).toHaveLength(0);
  });

  it('equals emits exact match', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'equals', value: 'prod' })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': 'prod' });
  });

  it('not_equals with include_missing=true uses bare $ne (matches missing)', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'not_equals', value: 'dev', include_missing: true })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $ne: 'dev' } });
  });

  it('not_equals with include_missing=false requires key present', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'not_equals', value: 'dev', include_missing: false })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $exists: true, $ne: 'dev' } });
  });

  it('in emits $in', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'in', values: ['prod', 'staging'] })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $in: ['prod', 'staging'] } });
  });

  it('not_in with include_missing=true uses bare $nin (matches missing)', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'not_in', values: ['dev'], include_missing: true })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $nin: ['dev'] } });
  });

  it('not_in with include_missing=false requires key present', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'not_in', values: ['dev'], include_missing: false })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $exists: true, $nin: ['dev'] } });
  });

  it('exists emits $exists true', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'exists' })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $exists: true } });
  });

  it('not_exists emits $exists false', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'not_exists' })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': { $exists: false } });
  });

  it('contains emits case-insensitive $regex with escaped value', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [mf({ key: 'msg', op: 'contains', value: 'a.b' })],
    });
    expect(metaClauses(r as never)).toContainEqual({
      'metadata.msg': { $regex: 'a\\.b', $options: 'i' },
    });
  });

  it('combines multiple filters as separate $and clauses', () => {
    const r = translator.translateQuery({
      ...baseParams,
      metadataFilters: [
        mf({ key: 'env', op: 'equals', value: 'prod' }),
        mf({ key: 'region', op: 'in', values: ['us', 'eu'] }),
      ],
    });
    const clauses = metaClauses(r as never);
    expect(clauses).toContainEqual({ 'metadata.env': 'prod' });
    expect(clauses).toContainEqual({ 'metadata.region': { $in: ['us', 'eu'] } });
  });

  it('applies metadata filters in translateCount as well', () => {
    const r = translator.translateCount({
      ...baseParams,
      metadataFilters: [mf({ key: 'env', op: 'equals', value: 'prod' })],
    });
    expect(metaClauses(r as never)).toContainEqual({ 'metadata.env': 'prod' });
  });
});
