/** Roadmap canvas: the bottom-up graph (pan + zoom) and the tree view.
 *
 * Controlled component: `render` receives the authoritative path and UI state;
 * clicks are reported through callbacks. All listeners belong to the signal.
 */
import type { LearningPath, PathModule, PathNode } from "../domain.ts";
import { locale, t } from "../i18n.ts";
import type { MessageKey } from "../i18n.ts";
import type { NodePrerequisites } from "../node-catalog-link.ts";
import { ICONS, setIcon, statusIcon } from "./icons.ts";
import { buildDependencyGraph, isDone, layoutRoadmap, moduleCounts } from "./roadmap-layout.ts";
import type { PlacedModule, RoadmapLayout } from "./roadmap-layout.ts";

export type ViewMode = "graph" | "tree";

export interface CanvasState {
  readonly path: LearningPath;
  readonly selectedNodeId: string | null;
  readonly expandedModuleId: string | null;
  readonly view: ViewMode;
  readonly showOptional: boolean;
  /** The legend shows only when the side panel is closed, as in the mockups. */
  readonly showLegend: boolean;
  /** Prerequisites per node. Absent: module order (the view has no catalog). */
  readonly prerequisites?: readonly NodePrerequisites[];
}

export interface CanvasCallbacks {
  selectNode(nodeId: string): void;
  toggleModule(moduleId: string): void;
}

export interface RoadmapCanvas {
  render(state: CanvasState): void;
  dispose(): void;
}

/** Indent per tree level, in px. */
const TREE_INDENT = 18;

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function moduleState(module: PathModule): "done" | "progress" | "todo" {
  const { done, total } = moduleCounts(module);
  if (total > 0 && done === total) return "done";
  if (done > 0 || module.nodes.some((node) => node.progression === "in_progress")) return "progress";
  return "todo";
}

/** "K&R, ch. 5" style anchor for a module header: the first anchored chapter. */
export function moduleSource(module: PathModule): string | null {
  const anchor = module.nodes.find((node) => node.sourceAnchor.chapter)?.sourceAnchor ?? module.nodes[0]?.sourceAnchor;
  if (!anchor) return null;
  const short = anchor.reference.split(/[,:(—–-]/)[0]!.trim();
  if (!anchor.chapter) return short;
  return `${short} ${locale() === "ru" ? "гл." : "ch."} ${anchor.chapter}`;
}

function unresolved(node: PathNode): number {
  return node.errors.filter((entry) => !entry.resolved).length;
}

export function createRoadmapCanvas(
  document: Document,
  host: HTMLElement,
  signal: AbortSignal,
  callbacks: CanvasCallbacks,
): RoadmapCanvas {
  const root = el(document, "div", "rm-canvas");
  const viewport = el(document, "div", "rm-viewport");
  const stage = el(document, "div", "rm-stage");
  viewport.append(stage);
  const tree = el(document, "div", "rm-tree");
  const controls = el(document, "div", "rm-zoom");
  const zoomOut = el(document, "button", "rm-zoom-btn");
  const zoomLabel = el(document, "button", "rm-zoom-value", "100%");
  const zoomIn = el(document, "button", "rm-zoom-btn");
  setIcon(zoomOut, ICONS.minus);
  setIcon(zoomIn, ICONS.plus);
  zoomOut.type = zoomIn.type = zoomLabel.type = "button";
  zoomOut.setAttribute("aria-label", "−");
  zoomIn.setAttribute("aria-label", "+");
  zoomLabel.title = t("zoom.fit");
  controls.append(zoomOut, zoomLabel, zoomIn);
  const legend = el(document, "div", "rm-legend");
  root.append(viewport, tree, controls, legend);
  host.append(root);

  let state: CanvasState | null = null;
  let layout: RoadmapLayout | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let placedPathId: string | null = null;
  let focusModuleId: string | null = null;
  /** Tree rows whose children the learner collapsed; everything else starts expanded. */
  const collapsedTreeNodes = new Set<string>();
  let disposed = false;

  const applyTransform = (): void => {
    stage.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const clampPan = (): void => {
    if (!layout) return;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const w = layout.width * scale;
    const h = layout.height * scale;
    tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
    ty = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ty));
  };

  /** Show the start of the map (bottom) when the expanded module is visible from
   * there, as in the mockup; otherwise center the expanded module. */
  const focus = (moduleId: string | null): void => {
    if (!layout) return;
    const vh = viewport.clientHeight;
    const bottomAligned = vh - layout.height * scale;
    const target = layout.modules.find((placed) => placed.module.id === moduleId);
    if (!target || target.y * scale + bottomAligned >= 12) ty = bottomAligned;
    else ty = vh / 2 - (target.y + target.h / 2) * scale;
    tx = (viewport.clientWidth - layout.width * scale) / 2;
    clampPan();
    applyTransform();
  };

  const setScale = (next: number, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2): void => {
    const clamped = Math.min(1.6, Math.max(0.4, Math.round(next * 100) / 100));
    tx = cx - ((cx - tx) / scale) * clamped;
    ty = cy - ((cy - ty) / scale) * clamped;
    scale = clamped;
    clampPan();
    applyTransform();
  };

  const fit = (): void => {
    if (!layout) return;
    const fitScale = Math.min(1, viewport.clientWidth / layout.width, viewport.clientHeight / layout.height);
    scale = Math.max(0.4, Math.round(fitScale * 100) / 100);
    clampPan();
    applyTransform();
  };

  zoomOut.addEventListener("click", () => setScale(scale - 0.1), { signal });
  zoomIn.addEventListener("click", () => setScale(scale + 0.1), { signal });
  zoomLabel.addEventListener("click", () => (scale === 1 ? fit() : setScale(1)), { signal });
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect();
        setScale(scale * (event.deltaY > 0 ? 0.9 : 1.1), event.clientX - rect.left, event.clientY - rect.top);
        return;
      }
      tx -= event.shiftKey ? event.deltaY : event.deltaX;
      ty -= event.shiftKey ? 0 : event.deltaY;
      clampPan();
      applyTransform();
    },
    { signal, passive: false },
  );

  let drag: { x: number; y: number; tx: number; ty: number; id: number } | null = null;
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      drag = { x: event.clientX, y: event.clientY, tx, ty, id: event.pointerId };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("rm-dragging");
    },
    { signal },
  );
  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      tx = drag.tx + event.clientX - drag.x;
      ty = drag.ty + event.clientY - drag.y;
      clampPan();
      applyTransform();
    },
    { signal },
  );
  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    viewport.classList.remove("rm-dragging");
  };
  viewport.addEventListener("pointerup", endDrag, { signal });
  viewport.addEventListener("pointercancel", endDrag, { signal });

  // Absent in some embedders and in DOM test environments; panning still clamps on input.
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (disposed || !layout) return;
          clampPan();
          applyTransform();
        })
      : null;
  resize?.observe(viewport);

  const nodeButton = (node: PathNode, selected: boolean, x: number | null, y: number | null, w: number | null): HTMLButtonElement => {
    const button = el(document, "button", "rm-node");
    button.type = "button";
    button.dataset.nodeId = node.id;
    if (selected) button.classList.add("rm-sel");
    if (node.optional) button.classList.add("rm-opt");
    if (node.alternativeGroup) button.classList.add("rm-alt");
    if (node.progression === "skipped") button.classList.add("rm-skip");
    if (node.progression === "consolidated") button.classList.add("rm-done");
    if (node.progression === "in_progress") button.classList.add("rm-prog");
    if (node.type === "checkpoint") button.classList.add("rm-check");
    if (x !== null && y !== null && w !== null) {
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.style.width = `${w}px`;
    }
    const icon = el(document, "span", "rm-node-icon");
    if (node.type === "checkpoint") {
      icon.classList.add("rm-flag");
      if (node.progression === "consolidated") icon.classList.add("rm-flag-done");
      setIcon(icon, ICONS.flag);
    } else {
      setIcon(icon, statusIcon(node.progression));
    }
    button.append(icon, el(document, "span", "rm-node-title", node.title));
    const tag = node.alternativeGroup ? t("mark.alternativeShort") : node.optional ? t("mark.optionalShort") : null;
    if (tag) button.append(el(document, "span", "rm-node-tag", tag));
    if (node.reviewMark) button.append(el(document, "span", "rm-node-review", t("mark.shortReviewShort")));
    const errors = unresolved(node);
    if (errors > 0) {
      const warn = el(document, "span", "rm-node-warn");
      warn.title = errors === 1 ? t("foot.error1") : t("foot.errors", { n: errors });
      setIcon(warn, ICONS.warn);
      button.append(warn);
    }
    button.title = node.title;
    button.addEventListener("click", () => {
      if (!disposed && !signal.aborted) callbacks.selectNode(node.id);
    }, { signal });
    return button;
  };

  const moduleHeaderText = (module: PathModule): string => {
    const { done, total } = moduleCounts(module);
    const status = moduleState(module);
    const parts = [
      status === "done" ? t("status.consolidated") : status === "progress" ? t("status.in_progress") : t("status.unstarted"),
      `${done} / ${total}`,
    ];
    const source = moduleSource(module);
    if (source) parts.push(source);
    return parts.join(" · ");
  };

  /** A module frame: the band around its nodes. Its header toggles the focus highlight. */
  const renderModule = (placed: PlacedModule): HTMLElement => {
    const { module } = placed;
    const box = el(document, "div", placed.expanded ? "rm-box rm-box-focus" : "rm-box");
    box.dataset.moduleId = module.id;
    box.style.left = `${placed.x}px`;
    box.style.top = `${placed.y}px`;
    box.style.width = `${placed.w}px`;
    box.style.height = `${placed.h}px`;
    const head = el(document, "button", "rm-box-head");
    head.type = "button";
    head.append(el(document, "span", "rm-box-title", module.title), el(document, "span", "rm-box-meta", moduleHeaderText(module)));
    head.title = module.goal ?? module.title;
    head.addEventListener("click", () => {
      if (!disposed && !signal.aborted) callbacks.toggleModule(module.id);
    }, { signal });
    box.append(head);
    if (placed.errorLine) {
      const first = module.nodes.flatMap((node) => node.errors.filter((entry) => !entry.resolved));
      const line = el(document, "div", "rm-box-error");
      line.style.left = `${placed.errorLine.x - placed.x}px`;
      line.style.top = `${placed.errorLine.y - placed.y}px`;
      const icon = el(document, "span", "rm-warn-icon");
      setIcon(icon, ICONS.warn);
      const text =
        first.length === 1
          ? t("box.openError1", { text: first[0]!.summary })
          : t("box.openErrors", { n: first.length, text: first[0]?.summary ?? "" });
      line.append(icon, el(document, "span", undefined, text));
      line.title = first.map((entry) => entry.summary).join("\n");
      box.append(line);
    }
    return box;
  };

  const renderEdges = (current: RoadmapLayout): SVGSVGElement => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "rm-edges");
    svg.setAttribute("width", String(current.width));
    svg.setAttribute("height", String(current.height));
    for (const edge of current.edges) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(edge.x1));
      line.setAttribute("y1", String(edge.y1));
      line.setAttribute("x2", String(edge.x2));
      line.setAttribute("y2", String(edge.y2));
      if (edge.dashed) line.setAttribute("class", "rm-dashed");
      svg.append(line);
      // Arrowhead at the dependent end: two wings laid back from the tip along the line.
      const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1) || 1;
      const ux = (edge.x2 - edge.x1) / length;
      const uy = (edge.y2 - edge.y1) / length;
      const baseX = edge.x2 - ux * 7;
      const baseY = edge.y2 - uy * 7;
      const wingX = -uy * 4;
      const wingY = ux * 4;
      const head = document.createElementNS(ns, "path");
      head.setAttribute(
        "d",
        `M${baseX + wingX} ${baseY + wingY} L${edge.x2} ${edge.y2} L${baseX - wingX} ${baseY - wingY}`,
      );
      head.setAttribute("class", "rm-arrow");
      svg.append(head);
    }
    return svg;
  };

  const renderGraph = (current: CanvasState): void => {
    layout = layoutRoadmap(current.path, {
      expandedModuleId: current.expandedModuleId,
      showOptional: current.showOptional,
      prerequisites: current.prerequisites,
    });
    stage.style.width = `${layout.width}px`;
    stage.style.height = `${layout.height}px`;
    const children: Element[] = [renderEdges(layout)];
    for (const placed of layout.modules) children.push(renderModule(placed));
    for (const group of layout.groups) {
      const bracket = el(document, "div", "rm-alt-group");
      bracket.style.left = `${group.x}px`;
      bracket.style.top = `${group.y1}px`;
      bracket.style.height = `${group.y2 - group.y1}px`;
      bracket.title = t("mark.alternative");
      children.push(bracket);
    }
    for (const placed of layout.nodes) {
      children.push(nodeButton(placed.node, placed.node.id === current.selectedNodeId, placed.x, placed.y, placed.w));
    }
    stage.replaceChildren(...children);
    const pathChanged = placedPathId !== current.path.id;
    const expandedChanged = focusModuleId !== current.expandedModuleId;
    placedPathId = current.path.id;
    focusModuleId = current.expandedModuleId;
    if (pathChanged) {
      scale = 1;
      // Wait one frame so the viewport has its real size on first mount.
      const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (run: () => void) => setTimeout(run, 0);
      schedule(() => {
        if (!disposed) focus(current.expandedModuleId);
      });
    } else if (expandedChanged) {
      clampPan();
      applyTransform();
    } else {
      clampPan();
      applyTransform();
    }
  };

  /** Nested tree: each node sits under its deepest prerequisite, one indent per dependency level.
   * Any number of children; a row's toggle collapses only that row's children. */
  const renderTree = (current: CanvasState): void => {
    const graph = buildDependencyGraph(current.path, { showOptional: current.showOptional, prerequisites: current.prerequisites });
    const byId = new Map<string, { node: PathNode; module: PathModule }>();
    for (const module of current.path.modules) {
      for (const node of module.nodes) byId.set(node.id, { node, module });
    }
    const children = new Map<string, string[]>();
    const roots: string[] = [];
    for (const id of graph.nodeIds) {
      const parentId = graph.parent.get(id) ?? null;
      if (parentId === null) roots.push(id);
      else children.set(parentId, [...(children.get(parentId) ?? []), id]);
    }
    const list = el(document, "div", "rm-tree-list");
    const addRow = (id: string, level: number): void => {
      const entry = byId.get(id);
      if (!entry) return;
      const kids = children.get(id) ?? [];
      const expanded = !collapsedTreeNodes.has(id);
      const row = el(document, "div", "rm-tree-row");
      row.style.paddingLeft = `${level * TREE_INDENT}px`;
      if (kids.length > 0) {
        const toggle = el(document, "button", "rm-tree-toggle");
        toggle.type = "button";
        toggle.title = expanded ? t("tree.collapse") : t("tree.expand");
        toggle.setAttribute("aria-label", toggle.title);
        setIcon(toggle, expanded ? ICONS.chevronDown : ICONS.chevronRight);
        toggle.addEventListener("click", () => {
          if (disposed || signal.aborted) return;
          if (collapsedTreeNodes.has(id)) collapsedTreeNodes.delete(id);
          else collapsedTreeNodes.add(id);
          if (state) renderTree(state);
        }, { signal });
        row.append(toggle);
      } else {
        row.append(el(document, "span", "rm-tree-toggle rm-tree-toggle-empty"));
      }
      const button = nodeButton(entry.node, entry.node.id === current.selectedNodeId, null, null, null);
      button.classList.add("rm-tree-node");
      row.append(button, el(document, "span", "rm-tree-module-tag", entry.module.title));
      const parentId = graph.parent.get(id) ?? null;
      const others = graph.edges
        .filter((edge) => edge.to === id && edge.from !== parentId)
        .map((edge) => byId.get(edge.from)?.node.title)
        .filter((title): title is string => title !== undefined);
      if (others.length > 0) row.append(el(document, "span", "rm-tree-also", t("tree.alsoAfter", { titles: others.join(", ") })));
      list.append(row);
      if (expanded) for (const kid of kids) addRow(kid, level + 1);
    };
    for (const id of roots) addRow(id, 0);
    tree.replaceChildren(list);
  };

  const renderLegend = (): void => {
    const item = (icon: string, key: MessageKey, extraClass = ""): HTMLElement => {
      const span = el(document, "span", `rm-legend-item ${extraClass}`);
      const iconHost = el(document, "span", "rm-legend-icon");
      setIcon(iconHost, icon);
      span.append(iconHost, el(document, "span", undefined, t(key)));
      return span;
    };
    const lineItem = (dashed: boolean, key: MessageKey): HTMLElement => {
      const span = el(document, "span", "rm-legend-item");
      span.append(el(document, "span", dashed ? "rm-legend-line rm-dashed-line" : "rm-legend-line"), el(document, "span", undefined, t(key)));
      return span;
    };
    const arrowItem = el(document, "span", "rm-legend-item");
    arrowItem.append(el(document, "span", "rm-legend-arrow", "→"), el(document, "span", undefined, t("legend.arrow")));
    const alt = el(document, "span", "rm-legend-item");
    alt.append(el(document, "span", "rm-legend-alt", t("mark.alternativeShort")), el(document, "span", undefined, t("mark.alternative")));
    const swatch = (state: "consolidated" | "in_progress" | "unstarted" | "skipped", key: MessageKey): HTMLElement => {
      const span = el(document, "span", "rm-legend-item");
      const chip = el(document, "span", `rm-legend-swatch rm-node${state === "consolidated" ? " rm-done" : state === "in_progress" ? " rm-prog" : state === "skipped" ? " rm-skip" : ""}`);
      setIcon(chip, statusIcon(state));
      span.append(chip, el(document, "span", undefined, t(key)));
      return span;
    };
    legend.replaceChildren(
      swatch("consolidated", "status.consolidated"),
      swatch("in_progress", "status.in_progress"),
      swatch("unstarted", "status.unstarted"),
      swatch("skipped", "status.skipped"),
      lineItem(true, "mark.optional"),
      alt,
      item(ICONS.flag, "legend.checkpoint"),
      item(ICONS.warn, "legend.error", "rm-legend-warn"),
      arrowItem,
      el(
        document,
        "span",
        "rm-legend-item rm-legend-note",
        state !== null && state.path.modules.some((module) => module.nodes.some((node) => node.prerequisites !== undefined))
          ? t("legend.prerequisitesNote")
          : t("legend.moduleOrder"),
      ),
    );
  };

  return {
    render(next) {
      if (disposed || signal.aborted) return;
      state = next;
      root.dataset.view = next.view;
      viewport.hidden = next.view !== "graph";
      controls.hidden = next.view !== "graph";
      tree.hidden = next.view !== "tree";
      legend.hidden = !next.showLegend || next.view !== "graph";
      renderLegend();
      if (next.view === "graph") renderGraph(next);
      else renderTree(next);
      void state;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resize?.disconnect();
      root.remove();
    },
  };
}

export { isDone };
