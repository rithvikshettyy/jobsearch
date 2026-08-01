import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import type { Source, SourceId } from '../types';

export const SOURCES: Record<SourceId, Source> = { greenhouse, lever, ashby };

export function isSourceId(value: string): value is SourceId {
	return value === 'greenhouse' || value === 'lever' || value === 'ashby';
}

export function getSource(id: SourceId): Source {
	return SOURCES[id];
}
