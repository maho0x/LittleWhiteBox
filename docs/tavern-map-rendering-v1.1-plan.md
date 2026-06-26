# Tavern Map Rendering v1.1 Plan

## Core Principle

Agent owns facts. Renderer owns aesthetics.

The map system must remain a structured, replayable, repairable spatial state. The model submits semantic facts through `MapPatch`; it must not hand-author SVG patterns, gradients, opacity, blend modes, z-index, or decorative redraws.

Renderer code deterministically turns the same state into the same visual map.

## Current Problems

1. The current map schema expresses geometry and category, but not material or mood.
   A tavern wooden floor, a dungeon tile floor, and an outdoor dirt patch all collapse into generic `terrain` unless the model writes fragile style overrides.

2. Current rendering colors are mostly category defaults.
   This produces a useful tactical sketch, but not a scene map with wood, stone, carpet, blood, water, shadow, or ambient light.

3. There is no renderer-owned material library.
   SVG `<pattern>` and `<gradient>` assets should live in the renderer, not in model patches.

4. Existing manager guidance correctly favors "patch only real spatial changes."
   Adding visual vocabulary must not reopen the path where the model patches every turn just to make the map prettier.

5. Label canonicalization needs lifecycle semantics.
   Derived labels must follow their source element and disappear when the source no longer carries label text.

## Schema Final Shape

Keep existing shape fields:

```ts
rect | circle | path | curve | icon | text
```

Do not add a parallel `shape` field.

### Categories

Keep existing categories and add only one new category:

```ts
type TavernMapElementCategory =
  | 'wall'
  | 'road'
  | 'water'
  | 'terrain'
  | 'furniture'
  | 'door'
  | 'danger'
  | 'marker'
  | 'actor'
  | 'label'
  | 'grid'
  | 'magic'
  | 'secret'
  | 'light';
```

`terrain` means walkable ground or surface. Do not add `floor`, `ground`, or `region`.

`light` is a real semantic category for light, glow, shadow, and ambient patches. Do not overload `magic` for mundane firelight.

### New Semantic Fields

```ts
type TavernMapMood =
  | 'neutral'
  | 'warm'
  | 'cold'
  | 'dark'
  | 'mystic'
  | 'danger'
  | 'calm';

type TavernMapMaterial =
  | 'unknown'
  | 'wood'
  | 'stone'
  | 'tile'
  | 'carpet'
  | 'blood'
  | 'water'
  | 'grass'
  | 'dirt'
  | 'snow'
  | 'metal'
  | 'rune'
  | 'warm-light'
  | 'cold-light'
  | 'shadow';

type TavernMapCertainty =
  | 'confirmed'
  | 'inferred'
  | 'unknown';
```

Add:

```ts
interface TavernMapDocumentMeta {
  mood?: TavernMapMood;
}

interface TavernMapElement {
  material?: TavernMapMaterial;
  certainty?: TavernMapCertainty;
}
```

Defaults:

```ts
meta.mood = 'neutral'
element.certainty = 'confirmed'
```

`material` may be omitted. Omitted material lets the renderer fall back to category defaults.

### Explicit Non-Goals

Do not add these in v1.1:

```ts
floor
ground
region
subtype
opacity
presence
nature
zIndex
rotation
scale
blur
```

Virtual or spectral actors are a known v1.1 gap. Do not use `material:'shadow'` to represent an actor being a ghost. If this becomes common, add a future orthogonal field:

```ts
nature?: 'physical' | 'spectral'
```

## Example State

```json
{
  "meta": {
    "name": "Old Hound Inn - Upstairs Room",
    "viewBox": [0, 0, 400, 300],
    "theme": "dark",
    "status": "active",
    "mood": "warm"
  },
  "elements": [
    {
      "id": "room-ground",
      "cat": "terrain",
      "material": "wood",
      "at": [20, 20],
      "rect": [360, 260]
    },
    {
      "id": "room-wall",
      "cat": "wall",
      "material": "stone",
      "at": [20, 20],
      "rect": [360, 260]
    },
    {
      "id": "rug",
      "cat": "furniture",
      "material": "carpet",
      "at": [220, 90],
      "rect": [100, 140],
      "text": "Persian rug"
    },
    {
      "id": "firelight",
      "cat": "light",
      "material": "warm-light",
      "at": [60, 60],
      "circle": 90
    },
    {
      "id": "player",
      "cat": "actor",
      "actorKey": "player",
      "at": [280, 120],
      "icon": "o",
      "text": "Player"
    }
  ]
}
```

Stored canonical state must split geometry text into a derived label:

```json
{ "id": "rug", "cat": "furniture", "material": "carpet", "at": [220, 90], "rect": [100, 140] }
{ "id": "__label__rug", "cat": "label", "at": [...], "text": "Persian rug" }
```

## Normalize And Canonical Rules

### Closed Enumerations

`material`, `mood`, and `certainty` are closed enums.

For model input:

```text
valid enum value -> keep
invalid enum value -> warning + ignore field
explicit "unknown" -> keep as unknown
```

Do not fuzzy-match material names. CJK material aliases are an infinite mapping problem and would make replay less stable.

### Legacy Category Repair

If stored dirty data contains `cat:'floor'` or `cat:'ground'`, repair to `cat:'terrain'`.

Do not expose `floor` or `ground` in tool schema or prompts.

### Fill Is Legacy/Internal

`fill` remains for legacy/manual compatibility only.

New model-facing prompts should not teach `fill`.

When model input contains both valid `material` and `fill`:

```text
drop fill
emit warning
keep material
```

When model input contains `fill` without `material`, keep current compatibility behavior for now, but treat it as a legacy/manual path rather than the preferred semantic path.

### Actor Material Guard

`material:'shadow'` must not be used to mean "this actor is spectral."

For `cat:'actor'`:

```text
material:'shadow' -> warning + ignore material
```

Actor identity and role stay with `actorKey` and existing actor semantics.

### Label Lifecycle

Derived labels are lifecycle-bound to their source geometry.

Let `labelId = "__label__" + id`.

```text
if cat does not allow labels:
  delete derived labelId

if cat allows labels and source currently has text:
  create/update derived labelId

if cat allows labels and source currently has no text:
  delete derived labelId
```

Default no-label categories:

```text
terrain
light
grid
```

Default label-eligible categories:

```text
actor
furniture
door
danger
water
magic
secret
marker
road
wall
```

This prevents stale labels after a later geometry patch removes or stops carrying text.

## No-Op Gate

No-op is based on a semantic fingerprint, not raw document equality.

Patch application pipeline:

```text
raw patch
-> normalize/canonical
-> apply candidate document
-> semanticFingerprint(current) vs semanticFingerprint(candidate)
-> equal: no save, no revision, no replay
-> different: save one atomic patch revision
```

### semanticFingerprint(doc)

This pure function is a core v1.1 primitive.

Fingerprint includes:

```text
meta:
  name
  mood
  viewBox
  theme
  status
  hint

elements:
  sorted by id
  exclude derived __label__ elements as independent elements
  include source fields:
    id
    cat
    at
    rect
    circle
    path
    curve
    icon
    material
    certainty
    actorKey
    fill
    style
  text
  fold __label__<id>.at back onto the base element as labelAt
  fold __label__<id>.text back onto the base element as labelText
  fold __label__<id>.style back onto the base element as labelStyle
```

Fingerprint excludes:

```text
revision
createdAt
updatedAt
patch ids
element array order
render animation state
derived label element ordering
```

The function must be idempotent:

```text
semanticFingerprint(normalize(doc)) === semanticFingerprint(normalize(normalize(doc)))
```

## Renderer

Main path must remain pure:

```text
pure(doc) -> svg
```

No cross-frame state is required for v1.1 rendering.

### Material Library

`materialEntry(material)` is a pure function and a core v1.1 primitive.

```ts
interface MaterialEntry {
  paint: string;
  blend?: 'normal' | 'multiply' | 'screen' | 'overlay';
  layer: 'fill' | 'light';
  opacity?: number;
}
```

Initial entries:

```ts
wood       -> { paint: 'url(#mat-wood)',   blend: 'normal',   layer: 'fill' }
stone      -> { paint: 'url(#mat-stone)',  blend: 'normal',   layer: 'fill' }
tile       -> { paint: 'url(#mat-tile)',   blend: 'normal',   layer: 'fill' }
carpet     -> { paint: 'url(#mat-carpet)', blend: 'normal',   layer: 'fill' }
blood      -> { paint: 'url(#mat-blood)',  blend: 'multiply', layer: 'fill',  opacity: 0.85 }
water      -> { paint: 'url(#mat-water)',  blend: 'normal',   layer: 'fill',  opacity: 0.9 }
grass      -> { paint: 'url(#mat-grass)',  blend: 'normal',   layer: 'fill' }
dirt       -> { paint: 'url(#mat-dirt)',   blend: 'normal',   layer: 'fill' }
snow       -> { paint: 'url(#mat-snow)',   blend: 'normal',   layer: 'fill' }
metal      -> { paint: 'url(#mat-metal)',  blend: 'normal',   layer: 'fill' }
rune       -> { paint: 'url(#mat-rune)',   blend: 'screen',   layer: 'fill',  opacity: 0.8 }
warm-light -> { paint: 'url(#grad-warm)',  blend: 'screen',   layer: 'light', opacity: 0.7 }
cold-light -> { paint: 'url(#grad-cold)',  blend: 'screen',   layer: 'light', opacity: 0.6 }
shadow     -> { paint: '#000',             blend: 'multiply', layer: 'light', opacity: 0.5 }
unknown    -> no material entry; use cat fallback
```

`mix-blend-mode` should be applied to SVG elements through style. Test whether SVG layer isolation is needed so light/shadow blend does not leak incorrectly into the outer UI.

### Paint Resolution

Fill/paint decision:

```text
1. materialEntry(material)
2. legacy/internal fill
3. category fallback paint/color
```

When a model patch supplies a valid material for an element that already has
legacy/internal fill, canonicalization drops the old fill and emits a warning.

Material entries with `layer:'light'` render in the light layer even when the element category is not `light`.

### Fill Layer Ordering

`zOf(cat, material)` is a pure function and a core v1.1 primitive.

Fill items sort by:

```text
zOf(cat, material), then id lexicographically
```

Initial z order:

```text
10 terrain
20 water
30 road
40 furniture area shapes
50 danger
50 secret
60 magic area shapes
90 fallback fill
```

The id tiebreak is required for replay stability.

### Global Layer Order

```text
fill layer
line layer
light layer
mood overlay
label layer
```

`mood overlay` is independent. It does not belong to fill or light, and it must render below labels so labels remain readable.

`removed layer` is defined but not enabled by default in v1.1.

### Mood Overlay

`meta.mood` maps to deterministic overlay paint/blend/opacity.

Examples:

```text
neutral -> no overlay or very mild neutral overlay
warm    -> warm amber screen/overlay
cold    -> cold blue overlay
dark    -> dark multiply vignette
mystic  -> violet/teal overlay
danger  -> low red tension overlay
calm    -> soft low-contrast overlay
```

Mood overlay must never participate in bounds or semantic fingerprint beyond `meta.mood` itself.

### Certainty Rendering

`certainty` is semantic confidence. It should not steal line-style responsibilities from `style.dash`.

Rendering guidance:

```text
confirmed -> normal
inferred  -> opacity modulation and optional small badge/glow
unknown   -> stronger fade and optional unknown marker
```

Do not use `certainty` to override `style.dash`.

### Actor Rendering

Actor rules are renderer-owned:

```text
actorKey:'player' -> highlighted player ring
other actors      -> normal actor marker
certainty         -> opacity/badge modulation
```

Do not use actor `material` to express spectral nature in v1.1.

## ViewBox And Bounds

Atmosphere must not move the camera.

Bounds participation:

```text
normal geometry categories -> participate normally
light elements             -> participate by light source center or tiny source radius, not glow radius
mood overlay               -> never participates
removed animation items    -> never participate in base fitting
renderer-only effects      -> never participate
```

This prevents a large corner firelight from shrinking the visible room.

## HUD

HUD is UI derived from state. It is not stored in `elements`.

HUD fields:

```text
name      -> meta.name
mood      -> meta.mood
revision  -> document revision
material  -> primary terrain material
highlights -> selected danger/magic/water/furniture labels
```

Deterministic selection:

```text
primary terrain:
  largest terrain area
  tie by id lexicographic order

highlight lists:
  sort by area descending
  tie by id lexicographic order
  take fixed N
```

HUD must be deterministic for replay consistency.

## Removed Layer Definition

Removed layer is an optional future animation feature.

Definition:

```text
prev.elements - curr.elements -> removed set
renderer temporarily draws removed set in red fade-out layer
animation end -> destroy temporary render items
```

It must not:

```text
enter document state
enter semantic fingerprint
participate in bounds
affect stable replay output
```

v1.1 default:

```text
disabled
main render remains pure(doc) -> svg
```

Consider enabling in v1.2 after the pure render path is stable.

## Agent Prompt Rules

The model should learn semantic facts, not rendering tricks.

Prompt guidance:

```text
Only write material/mood/certainty when RP text confirms it.
If unsure, omit the field.
Do not patch only to make the map prettier.
Do not redraw the whole map each turn.
No spatial or semantic change means no MapPatch.
Use terrain for ground/floor.
Use light for light, glow, and shadow areas.
Do not use floor, ground, region, subtype, opacity, visual scale, or custom fill colors.
Use only enum material/mood/certainty values.
```

Initialization may set obvious material and mood for a newly created scene. Later turns should not create patches just to backfill forgotten aesthetic data unless the user asks for a correction.

## Implementation Checklist

### Phase 1: Shared State And Tests

- [x] Add `light` to `TavernMapElementCategory`.
- [x] Add `mood` to map meta.
- [x] Add `material` and `certainty` to map element type.
- [x] Add closed enum normalization for mood/material/certainty.
- [x] Repair dirty `floor`/`ground` categories to `terrain` for stored documents only.
- [x] Guard `cat:'actor' material:'shadow'` with warning + ignored material.
- [x] Treat `fill` as legacy/internal; drop it when valid material is also supplied in model input.
- [x] Implement lifecycle-bound derived label canonicalization.
- [x] Implement `semanticFingerprint(doc)`.
- [x] Wire no-op gate to compare semantic fingerprints after canonical apply.
- [x] Update trusted replay helper if effective ops need canonical label cleanup.

### Phase 2: Renderer

- [x] Add SVG defs for initial material patterns and gradients.
- [x] Implement `materialEntry(material)`.
- [x] Implement `zOf(cat, material)`.
- [x] Split render items by material entry layer: fill vs light.
- [x] Sort fill items by `zOf` and stable id order.
- [x] Add light layer.
- [x] Add mood overlay between light and labels.
- [x] Keep label layer above mood overlay.
- [x] Add certainty opacity modulation without overriding `style.dash`.
- [x] Add player actor highlight ring.
- [x] Add SVG blend isolation in CSS.
- [x] Ensure light-layer materials and mood do not affect viewBox fitting.

### Phase 3: Tool Schema And Prompts

- [x] Update map element schema descriptions.
- [x] Add enum descriptions for material and certainty.
- [x] Add mood schema and descriptions.
- [x] Remove model-facing encouragement for `fill`.
- [x] Whitelist `ops[].set` so renderer styling fields are not model-facing.
- [x] Clarify atlas `scale` versus forbidden visual scale.
- [x] Update seed map hint examples with `terrain + material`, `light`, and `mood`.
- [x] Emphasize "omit unknown facts" and "do not patch for aesthetics."

### Phase 4: HUD

- [ ] Deferred for v1.1: HUD is intentionally not implemented unless it becomes a real user-facing need.

### Phase 5: Verification

- [x] `git diff --check`.
- [x] `npm run test:tavern`.
- [x] `npm run build:tavern`.

## Test Checklist

- [x] Old maps without material render using existing category fallback.
- [x] New tavern map renders wood terrain, carpet furniture, warm light, mood overlay, and player highlight.
- [x] New dungeon map renders tile/stone, blood, cold light/shadow, and cold/dark mood.
- [x] Invalid material in model input is warning + ignored, not fuzzy matched.
- [x] `material:'wood'` plus `fill:'#f00'` drops fill and warns.
- [x] `cat:'actor' material:'shadow'` ignores material and warns.
- [x] `cat:'light'` does not create derived labels.
- [x] `terrain` does not create derived labels by default.
- [x] Label lifecycle clears stale `__label__<id>` when source text is removed.
- [x] Label text changes alter semantic fingerprint through folded `labelText`.
- [x] Derived label element order does not change semantic fingerprint.
- [x] Same normalized document fingerprint is stable across repeated normalize passes.
- [x] Reordered elements with same semantic content produce the same fingerprint.
- [x] No-op material/mood/certainty patches do not save a revision.
- [x] Invalid enum-only patches become no-op when candidate state is unchanged.
- [x] Light glow does not expand auto-fit viewBox.
- [x] Light-layer materials do not expand auto-fit viewBox.
- [x] Mood overlay does not participate in bounds.
- [x] Certainty modulation does not overwrite `style.dash`.
- [x] Fill sublayer order is deterministic by `zOf` and stable id order.
- [ ] Deferred with HUD: HUD primary terrain is deterministic by area, then id.

## Delivery Boundary

This is test-line work unless merged into `upstream`.

Do not write compatibility branches for older LittleWhiteBox test-line experiments unless explicitly requested. Compatibility targets are SillyTavern, browser/WebView behavior, current storage format safety, and explicitly preserved user data.
