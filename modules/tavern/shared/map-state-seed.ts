export const TAVERN_MAP_DOC_TYPE = 'tavern.map' as const;
export const TAVERN_MAP_DOC_ID = 'main';
export const TAVERN_MAP_LABEL_PREFIX = '__label__';

export type TavernMapTheme = 'parchment' | 'paper' | 'dark' | 'blueprint' | 'grid';
export type TavernMapStatus = 'uninitialized' | 'active';

export interface TavernSeedMapDocument {
    meta: {
        name: string | null;
        viewBox: [number, number, number, number] | null;
        theme: TavernMapTheme;
        status: TavernMapStatus;
        hint: string;
    };
    elements: [];
}

export function buildSeedMapHint(): string {
    return [
        'This scene map is empty. Use it only after it has been chosen for a specific confirmed place, then initialize it with one minimal StatePatch. Use `activate:true` only to switch the map tool doc, not to move the player; player location belongs in `tavern.atlas/main` via move-actor.',
        'Indoor example: {"activate":true,"ops":[{"op":"meta","set":{"name":"<Place Name>","viewBox":[0,0,400,300],"status":"active"}},{"op":"add","element":{"id":"wall","at":[40,40],"rect":[320,220],"cat":"wall"}},{"op":"add","element":{"id":"door","at":[200,260],"icon":"o","cat":"door"}},{"op":"add","element":{"id":"player-room","actorKey":"player","at":[200,180],"icon":"o","text":"Player","cat":"actor"}}]}',
        'Outdoor example: {"activate":true,"ops":[{"op":"meta","set":{"name":"<Place Name>","viewBox":[0,0,800,600],"status":"active"}},{"op":"add","element":{"id":"ground","at":[400,300],"circle":150,"cat":"terrain"}},{"op":"add","element":{"id":"path","at":[0,300],"path":[[800,0]],"cat":"road"}},{"op":"add","element":{"id":"player-road","actorKey":"player","at":[400,320],"icon":"o","text":"Player","cat":"actor"}}]}',
        'Requirement: include at least one spatial geometry element (`rect`, `circle`, `path`, `curve`, or `icon`). Do not send only `text` labels. After initialization, use only incremental `add` / `modify` / `remove` ops. If nothing changes spatially, skip the map update instead of resetting the document.',
        'Use StateList before scene switches. For connected places, grow the same document by adding adjacent spaces and enlarging `meta.viewBox`; for clearly separate named locations, find or create a place-named docId and link it from the atlas location `mapDocId` instead of replacing an old map.',
        'Use `meta.name` as the map scope title. Area labels are allowed only when they mark a concrete visible region; place them inside or next to that region, not at the top edge as a second title.',
        '`viewBox` is the camera. Changing it does not move any element. Move the player by updating the player `at`, then adjust `meta.viewBox` only if the camera should follow.',
        'Elements use `at:[x,y]` plus one shape field: `rect`, `circle`, `path`, `curve`, `icon`, or `text`. With `at`, `path` and `curve` points are relative offsets. Without `at`, points are absolute coordinates and the first point becomes the anchor. For `cat:"actor"`, use `actorKey` as the full-session identity key; if omitted, id is the fallback.',
    ].join(' ');
}

export function createSeedMapDocument(): TavernSeedMapDocument {
    return {
        meta: {
            name: null,
            viewBox: null,
            theme: 'parchment',
            status: 'uninitialized',
            hint: buildSeedMapHint(),
        },
        elements: [],
    };
}

export function isSeedLabelId(value: unknown): boolean {
    return String(value || '').startsWith(TAVERN_MAP_LABEL_PREFIX);
}

export function buildSeedLabelId(id: string): string {
    return `${TAVERN_MAP_LABEL_PREFIX}${id}`;
}

export function isUninitializedMapData(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    const meta = (value as { meta?: { status?: unknown } }).meta;
    return meta?.status === 'uninitialized';
}
