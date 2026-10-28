import { adzuna } from './adzuna';
import { ashby } from './ashby';
import { greenhouse } from './greenhouse';
import { himalayas } from './himalayas';
import { jsearch } from './jsearch';
import { lever } from './lever';
import { remoteok } from './remoteok';
import { remotive } from './remotive';
import { smartrecruiters } from './smartrecruiters';
import type { Source, SourceId } from '../types';

export const SOURCES: Record<SourceId, Source> = { greenhouse, lever, ashby, remotive, remoteok, adzuna, jsearch, himalayas, smartrecruiters };

export function isSourceId(value: string): value is SourceId {
	return value in SOURCES;
}

export function getSource(id: SourceId): Source {
	return SOURCES[id];
}
