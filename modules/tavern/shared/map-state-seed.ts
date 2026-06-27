export const TAVERN_MAP_DOC_TYPE = 'tavern.map' as const;
export const TAVERN_MAP_DOC_ID = 'main';
export const TAVERN_MAP_LABEL_PREFIX = '__label__';

export type TavernMapTheme = 'parchment' | 'paper' | 'dark' | 'blueprint' | 'grid';
export type TavernMapStatus = 'uninitialized' | 'active';
export type TavernMapMood = 'neutral' | 'warm' | 'cold' | 'dark' | 'mystic' | 'danger' | 'calm';

export interface TavernSeedMapDocument {
    meta: {
        name: string | null;
        viewBox: [number, number, number, number] | null;
        theme: TavernMapTheme;
        status: TavernMapStatus;
        mood: TavernMapMood;
        hint: string;
    };
    elements: [];
}

export function buildSeedMapHint(): string {
    return [
        'This scene map is empty. Treat maps as files: read `world` with MapAtlasRead, choose an explicit scene name, then initialize this scene with MapSceneEdit.',
        'Indoor MapSceneEdit example: {"scene":"<Place Name>","playerHere":true,"viewBox":[0,0,400,300],"mood":"warm","elements":[{"id":"room-terrain","cat":"terrain","shape":"rect","geo":{"center":[200,150],"size":[320,220]},"material":"wood"},{"id":"wall","cat":"wall","shape":"rect","geo":{"center":[200,150],"size":[320,220]},"material":"stone","label":"<Place Name>"},{"id":"firelight","cat":"light","shape":"circle","geo":{"at":[80,80],"radius":70},"material":"warm-light"},{"id":"door","cat":"door","shape":"icon","geo":{"at":[200,260],"icon":"door"},"label":"Door"},{"id":"player-room","cat":"actor","actorKey":"player","shape":"icon","geo":{"at":[200,180],"icon":"o"},"label":"Player"}]}',
        'Outdoor MapSceneEdit example: {"scene":"<Place Name>","playerHere":true,"viewBox":[0,0,800,600],"mood":"neutral","elements":[{"id":"ground","cat":"terrain","shape":"circle","geo":{"at":[400,300],"radius":150},"material":"grass"},{"id":"path","cat":"road","shape":"path","geo":{"points":[[0,300],[800,300]]},"material":"dirt"},{"id":"player-road","cat":"actor","actorKey":"player","shape":"icon","geo":{"at":[400,320],"icon":"o"},"label":"Player"}]}',
        'Requirement: include at least one spatial geometry element with shape rect, circle, path, curve, or icon. Use only the minimum geo for that one shape; rect uses center+size, not at+size. Do not fill unused geo keys. Labels describe geometry but cannot replace it. If nothing changes spatially, skip the map update.',
        'Use MapSceneRead only when you need existing element ids. For connected places, keep editing the same explicit scene name and enlarge `viewBox` when the visible scope needs more room. For clearly separate named locations, use a separate explicit scene name.',
        'For `icon`, prefer semantic keys such as door/chest/table/bed/barrel/skull/trap/fire/tree/rock/water/heart/lips/lovers/cherish/love-letter/locked-heart/perfume; reserve x/o/+ and arrows for abstract markers.',
        'Use the scene name as the map scope title. Area labels are allowed only when they mark a concrete visible region; place them inside or next to that region, not at the top edge as a second title.',
        '`viewBox` is the camera. Changing it does not move any element. Move the player by updating the player coordinates, then adjust `viewBox` only if the camera should follow.',
        'Elements use `id`, `cat`, one `shape`, `geo`, and optional independent `label`. Put coordinates and dimensions inside `geo`; do not write internal rect/circle/path/curve/icon/text sibling fields.',
        'Use material/mood/certainty only for confirmed semantic facts. Material is a closed enum: unknown/wood/stone/tile/carpet/blood/water/grass/dirt/snow/metal/rune/warm-light/cold-light/shadow. Use terrain for ground/floor and light for glow/shadow; do not use region/subtype/opacity/custom fill colors or update only for aesthetics.',
    ].join(' ');
}

export function createSeedMapDocument(): TavernSeedMapDocument {
    return {
        meta: {
            name: null,
            viewBox: null,
            theme: 'parchment',
            status: 'uninitialized',
            mood: 'neutral',
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
