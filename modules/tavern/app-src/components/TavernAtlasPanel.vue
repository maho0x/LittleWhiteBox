<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TavernStructuredStateDocumentRecord, TavernStructuredStatePatchRecord } from '../../shared/session-db';
import type { TavernAtlasActorPosition, TavernAtlasDocument, TavernAtlasLink, TavernAtlasLocation, TavernMapStateDocumentItem } from '../../shared/structured-state';
import { layoutTavernAtlasDocument } from '../atlas-display';

const props = withDefaults(defineProps<{
    document: TavernStructuredStateDocumentRecord | null;
    patches?: TavernStructuredStatePatchRecord[];
    activeLocationKey?: string;
    activeMapDocId?: string;
    previewMapDocId?: string;
    mapDocuments?: TavernMapStateDocumentItem[];
    displayMode?: 'full' | 'graph' | 'detail';
}>(), {
    patches: () => [],
    activeLocationKey: '',
    activeMapDocId: 'main',
    previewMapDocId: '',
    mapDocuments: () => [],
    displayMode: 'full',
});

const selectedLocationKey = ref('');

const atlas = computed<TavernAtlasDocument>(() => {
    const raw = props.document?.data;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<TavernAtlasDocument> : {};
    return {
        version: 1,
        activeLocationKey: String(source.activeLocationKey || props.activeLocationKey || '').trim() || undefined,
        locations: Array.isArray(source.locations) ? source.locations.filter(isAtlasLocation) : [],
        links: Array.isArray(source.links) ? source.links.filter(isAtlasLink) : [],
        actors: Array.isArray(source.actors) ? source.actors.filter(isAtlasActor) : [],
    };
});
const layout = computed(() => layoutTavernAtlasDocument(atlas.value));
const locationMap = computed(() => new Map(atlas.value.locations.map((location) => [location.key, location])));
const selectedLocation = computed(() => locationMap.value.get(selectedLocationKey.value) || currentLocation.value || atlas.value.locations[0] || null);
const currentLocation = computed(() => locationMap.value.get(atlas.value.activeLocationKey || '') || null);
const currentMapDocId = computed(() => String(currentLocation.value?.mapDocId || '').trim());
const mapMismatchWarning = computed(() => !!currentMapDocId.value && !!props.activeMapDocId && currentMapDocId.value !== props.activeMapDocId);
const latestPatchSummary = computed(() => String(props.patches.at(-1)?.summary || '').trim());
const mapTitleById = computed(() => {
    const table = new Map<string, string>();
    props.mapDocuments.forEach((document) => table.set(document.docId, document.title || document.docId));
    return table;
});
const mapDocIds = computed(() => new Set(props.mapDocuments.map((document) => document.docId)));
const selectedActors = computed(() => actorsForLocation(selectedLocation.value?.key || ''));
const selectedLinks = computed(() => {
    const key = selectedLocation.value?.key || '';
    return atlas.value.links.filter((link) => link.from === key || link.to === key);
});
const showGraph = computed(() => props.displayMode !== 'detail');
const showDetail = computed(() => props.displayMode !== 'graph');

watch([() => atlas.value.activeLocationKey, () => atlas.value.locations.length], ([key]) => {
    if (selectedLocationKey.value && locationMap.value.has(selectedLocationKey.value)) {return;}
    selectedLocationKey.value = String(key || atlas.value.locations[0]?.key || '');
}, { immediate: true });

function isAtlasLocation(value: unknown): value is TavernAtlasLocation {
    return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as TavernAtlasLocation).key === 'string';
}

function isAtlasLink(value: unknown): value is TavernAtlasLink {
    return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as TavernAtlasLink).id === 'string';
}

function isAtlasActor(value: unknown): value is TavernAtlasActorPosition {
    return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as TavernAtlasActorPosition).actorKey === 'string';
}

function actorsForLocation(locationKey: string) {
    return atlas.value.actors
        .filter((actor) => actor.locationKey === locationKey)
        .sort((left, right) => {
            if (left.actorKey === 'player') {return -1;}
            if (right.actorKey === 'player') {return 1;}
            return left.actorKey.localeCompare(right.actorKey);
        });
}

function actorLabel(actor: TavernAtlasActorPosition): string {
    return actor.actorKey === 'player' ? '玩家' : actor.actorKey;
}

function nodeActors(locationKey: string): string {
    const actors = actorsForLocation(locationKey);
    if (!actors.length) {return '';}
    const labels = actors.slice(0, 2).map(actorLabel);
    return actors.length > 2 ? `${labels.join('、')} +${actors.length - 2}` : labels.join('、');
}

function locationClass(location: TavernAtlasLocation) {
    return {
        'is-current': location.key === atlas.value.activeLocationKey,
        'is-preview': location.mapDocId && location.mapDocId === props.previewMapDocId,
        'is-selected': location.key === selectedLocationKey.value,
        'is-mentioned': location.status === 'mentioned',
        'has-map': hasMapDocument(location),
    };
}

function hasMapDocument(location: TavernAtlasLocation | null | undefined): boolean {
    const docId = String(location?.mapDocId || '').trim();
    return !!docId && mapDocIds.value.has(docId);
}

function mapDocumentLabel(location: TavernAtlasLocation | null | undefined): string {
    const docId = String(location?.mapDocId || '').trim();
    if (!docId) {return '暂无详细地图';}
    return mapTitleById.value.get(docId) || `已关联 ${docId}，地图未创建`;
}

</script>

<template>
  <section
    class="tavern-atlas-panel"
    :class="`is-${displayMode}`"
  >
    <div
      v-if="!atlas.locations.length"
      class="tavern-atlas-empty"
    >
      <strong>世界地图尚未建立</strong>
      <p>随着剧情展开，AI 会自动记录你去过的地点，以及地点之间的联系。</p>
      <span>当前场景图：{{ mapTitleById.get(activeMapDocId) || activeMapDocId || 'main' }}</span>
    </div>
    <template v-else>
      <div
        v-if="showDetail && mapMismatchWarning"
        class="tavern-atlas-warning"
      >
        当前激活的场景图不是世界当前位置的地图。
      </div>
      <div
        v-if="showGraph"
        class="tavern-atlas-graph"
      >
        <svg
          :viewBox="layout.viewBox.join(' ')"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="世界图"
        >
          <path
            v-for="link in layout.links"
            :key="link.id"
            class="tavern-atlas-link"
            :class="`kind-${atlas.links.find((item) => item.id === link.id)?.kind || 'path'}`"
            :d="link.path"
          />
          <g
            v-for="node in layout.nodes"
            :key="node.key"
            class="tavern-atlas-node"
            :class="locationClass(locationMap.get(node.key)!)"
            role="button"
            tabindex="0"
            @click="selectedLocationKey = node.key"
            @keydown.enter.prevent="selectedLocationKey = node.key"
          >
            <rect
              :x="node.x"
              :y="node.y"
              :width="node.width"
              :height="node.height"
              rx="8"
            />
            <text
              :x="node.x + node.width / 2"
              :y="node.y + 22"
              text-anchor="middle"
            >
              {{ locationMap.get(node.key)?.name || node.key }}
            </text>
            <text
              :x="node.x + node.width / 2"
              :y="node.y + 40"
              text-anchor="middle"
              class="tavern-atlas-node-meta"
            >
              {{ nodeActors(node.key) || locationMap.get(node.key)?.scale }}
            </text>
          </g>
        </svg>
      </div>
      <aside
        v-if="showDetail"
        class="tavern-atlas-detail"
      >
        <header>
          <div>
            <strong>{{ selectedLocation?.name || '地点' }}</strong>
            <span>{{ selectedLocation?.key }}</span>
          </div>
          <em>{{ selectedLocation?.status === 'visited' ? '已探索' : '已知' }}</em>
        </header>
        <p v-if="selectedLocation?.brief">
          {{ selectedLocation.brief }}
        </p>
        <dl>
          <div>
            <dt>层级</dt>
            <dd>{{ selectedLocation?.scale || '-' }}</dd>
          </div>
          <div>
            <dt>上级</dt>
            <dd>{{ selectedLocation?.parent ? (locationMap.get(selectedLocation.parent)?.name || selectedLocation.parent) : '顶级地点' }}</dd>
          </div>
          <div>
            <dt>场景图</dt>
            <dd>{{ mapDocumentLabel(selectedLocation) }}</dd>
          </div>
          <div>
            <dt>人物</dt>
            <dd>{{ selectedActors.length ? selectedActors.map(actorLabel).join('、') : '无' }}</dd>
          </div>
        </dl>
        <div
          v-if="selectedLinks.length"
          class="tavern-atlas-detail-links"
        >
          <span
            v-for="link in selectedLinks"
            :key="link.id"
          >
            {{ link.label || link.kind }} · {{ locationMap.get(link.from)?.name || link.from }} → {{ locationMap.get(link.to)?.name || link.to }}
          </span>
        </div>
        <small v-if="latestPatchSummary">最近更新：{{ latestPatchSummary }}</small>
      </aside>
    </template>
  </section>
</template>

<style scoped>
.tavern-atlas-panel {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    overflow: hidden;
    background: var(--xb-chat-panel-bg);
}

.tavern-atlas-panel.is-graph,
.tavern-atlas-panel.is-detail {
    grid-template-rows: minmax(0, 1fr);
}

.tavern-atlas-panel.is-graph .tavern-atlas-graph {
    height: 100%;
}

.tavern-atlas-panel.is-graph .tavern-atlas-graph svg {
    min-height: 0;
}

.tavern-atlas-panel.is-detail .tavern-atlas-detail {
    min-height: 0;
    overflow: auto;
    border-top: 0;
}

.tavern-atlas-empty,
.tavern-atlas-detail {
    padding: 18px 34px 22px;
    color: var(--xb-ink);
    font-family: var(--xb-font-serif);
}

.tavern-atlas-empty {
    display: flex;
    min-height: 320px;
    flex-direction: column;
    justify-content: center;
    gap: 10px;
}

.tavern-atlas-empty strong {
    font: 600 18px/1.25 var(--xb-font-serif);
}

.tavern-atlas-empty p,
.tavern-atlas-empty span {
    margin: 0;
    color: var(--xb-ink-soft);
    font: 13px/1.55 var(--xb-font-ui);
}

.tavern-atlas-warning {
    border-bottom: 1px solid rgba(172, 92, 46, 0.28);
    background: rgba(172, 92, 46, 0.08);
    color: var(--xb-ink);
    font: 12px/1.35 var(--xb-font-ui);
    padding: 9px 34px;
}

.tavern-atlas-graph {
    min-height: 0;
    overflow: hidden;
}

.tavern-atlas-graph svg {
    width: 100%;
    height: 100%;
    min-height: 280px;
}

.tavern-atlas-link {
    fill: none;
    stroke: color-mix(in srgb, var(--xb-ink-faint) 55%, transparent);
    stroke-width: 2;
}

.tavern-atlas-link.kind-portal {
    stroke: var(--xb-stamp);
    stroke-dasharray: 5 5;
}

.tavern-atlas-link.kind-stairs,
.tavern-atlas-link.kind-elevator {
    stroke-dasharray: 3 4;
}

.tavern-atlas-node {
    cursor: pointer;
}

.tavern-atlas-node rect {
    fill: var(--xb-chat-editor-bg);
    stroke: var(--xb-rule);
    stroke-width: 1.4;
}

.tavern-atlas-node text {
    fill: var(--xb-ink);
    font: 13px/1 var(--xb-font-ui);
    pointer-events: none;
}

.tavern-atlas-node .tavern-atlas-node-meta {
    fill: var(--xb-ink-soft);
    font: 11px/1 var(--xb-font-mono);
}

.tavern-atlas-node.is-mentioned rect {
    fill: color-mix(in srgb, var(--xb-chat-editor-bg) 70%, transparent);
    stroke-dasharray: 4 4;
}

.tavern-atlas-node.has-map rect {
    stroke: color-mix(in srgb, var(--xb-stamp) 45%, var(--xb-rule));
}

.tavern-atlas-node.is-current rect {
    stroke: var(--xb-stamp);
    stroke-width: 2.2;
}

.tavern-atlas-node.is-preview rect,
.tavern-atlas-node.is-selected rect {
    filter: drop-shadow(0 5px 14px rgba(var(--xb-accent-rgb), 0.16));
}

.tavern-atlas-detail {
    border-top: 1px solid var(--xb-rule);
    background: var(--xb-chat-editor-bg);
}

.tavern-atlas-detail header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
}

.tavern-atlas-detail header div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.tavern-atlas-detail strong {
    overflow: hidden;
    color: var(--xb-ink);
    font: 600 var(--xb-host-main-font-size, 15px)/1.35 var(--xb-font-serif);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tavern-atlas-detail header span,
.tavern-atlas-detail small {
    color: var(--xb-ink-soft);
    font: 12px/1.3 var(--xb-font-mono);
}

.tavern-atlas-detail em {
    flex: 0 0 auto;
    border: 1px solid var(--xb-rule);
    border-radius: 6px;
    color: var(--xb-ink-soft);
    font: 12px/1.2 var(--xb-font-ui);
    font-style: normal;
    padding: 4px 8px;
}

.tavern-atlas-detail p {
    margin: 10px 0 0;
    color: var(--xb-ink-soft);
    font: 13px/1.55 var(--xb-font-ui);
}

.tavern-atlas-detail dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin: 13px 0 0;
}

.tavern-atlas-detail dl div {
    min-width: 0;
}

.tavern-atlas-detail dt {
    color: var(--xb-ink-faint);
    font: 11px/1.25 var(--xb-font-mono);
}

.tavern-atlas-detail dd {
    overflow: hidden;
    margin: 3px 0 0;
    color: var(--xb-ink);
    font: 13px/1.35 var(--xb-font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tavern-atlas-detail-links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 13px;
}

.tavern-atlas-detail-links span {
    border: 1px solid var(--xb-rule);
    border-radius: 6px;
    color: var(--xb-ink-soft);
    font: 11px/1.2 var(--xb-font-ui);
    padding: 4px 7px;
}

</style>
