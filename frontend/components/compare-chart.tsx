"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ChartSeries = {
  name: string;
  values: number[];
  limit: number | null;
  color: string;
};

const Y_TICKS = [0, 20, 40, 60, 80, 100];
const PAD_L = 42;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;

type Hover = { index: number; x: number; y: number };

function dayLabel(asOf: string, points: number, index: number) {
  const end = new Date(`${asOf}T00:00:00`);
  if (Number.isNaN(end.getTime())) return "";
  const day = new Date(end);
  day.setDate(day.getDate() - (points - 1 - Math.round(index)));
  return day.toISOString().slice(0, 10);
}

function paint(
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  series: ChartSeries[],
  focus: string | null,
  viewStart: number,
  viewSpan: number,
  asOf: string | null,
  hover: Hover | null,
) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  const width = Math.max(1, wrap.clientWidth);
  const height = Math.max(1, wrap.clientHeight);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(width * dpr));
  const bh = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const plotW = Math.max(1, width - PAD_L - PAD_R);
  const plotH = Math.max(1, height - PAD_T - PAD_B);
  const yOf = (value: number) => PAD_T + (1 - value / 100) * plotH;

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(161,161,170,0.9)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of Y_TICKS) {
    const y = Math.round(yOf(tick)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(width - PAD_R, y);
    ctx.stroke();
    ctx.fillText(String(tick), PAD_L - 6, yOf(tick));
  }

  let points = 1;
  for (const item of series) points = Math.max(points, item.values.length);
  const domain = Math.max(points - 1, 1);
  const span = Math.min(1, Math.max(viewSpan, Math.min(1, 8 / Math.max(points, 8))));
  const start = Math.min(Math.max(0, viewStart), 1 - span);
  const i0 = start * domain;
  const i1 = (start + span) * domain;
  const xOfIndex = (index: number) => PAD_L + ((index - i0) / Math.max(i1 - i0, 1e-6)) * plotW;

  ctx.textBaseline = "top";
  for (let mark = 0; mark <= 4; mark++) {
    if (!asOf || points < 2) continue;
    const index = i0 + ((i1 - i0) * mark) / 4;
    const edge = mark === 0 ? "left" : mark === 4 ? "right" : "center";
    ctx.textAlign = edge;
    const x = edge === "left" ? PAD_L : edge === "right" ? width - PAD_R : xOfIndex(index);
    ctx.fillText(dayLabel(asOf, points, index).slice(5), x, height - PAD_B + 6);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, PAD_T, plotW, plotH);
  ctx.clip();
  for (const item of series) {
    if (item.values.length === 0) continue;
    const dim = Boolean(focus && focus !== item.name);
    const origin = points - item.values.length;
    ctx.save();
    ctx.globalAlpha = dim ? 0.2 : 1;
    ctx.strokeStyle = item.color;
    ctx.lineWidth = focus === item.name ? 2 : 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(xOfIndex(origin), yOf(item.values[0]));
    for (let i = 1; i < item.values.length; i++) ctx.lineTo(xOfIndex(origin + i), yOf(item.values[i]));
    ctx.stroke();
    const last = item.values.length - 1;
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(xOfIndex(origin + last), yOf(item.values[last]), focus === item.name ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (hover && hover.index >= i0 - 0.5 && hover.index <= i1 + 0.5) {
    const x = Math.round(xOfIndex(hover.index)) + 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + plotH);
    ctx.stroke();
    for (const item of series) {
      const local = hover.index - (points - item.values.length);
      if (local < 0 || local >= item.values.length) continue;
      const y = yOf(item.values[Math.round(local)]);
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(xOfIndex(points - item.values.length + Math.round(local)), y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  if (!hover || !series.length) return;
  const rows: { name: string; color: string; value: string }[] = [];
  for (const item of series) {
    const local = Math.round(hover.index) - (points - item.values.length);
    if (local < 0 || local >= item.values.length) continue;
    rows.push({ name: item.name, color: item.color, value: item.values[local].toFixed(1) });
  }
  if (!rows.length) return;
  const title = asOf ? dayLabel(asOf, points, hover.index) : "";
  const boxW = 148;
  const boxH = 16 + rows.length * 14 + (title ? 14 : 0);
  let boxX = hover.x + 12;
  let boxY = hover.y + 12;
  if (boxX + boxW > width - 4) boxX = hover.x - boxW - 12;
  if (boxY + boxH > height - 4) boxY = hover.y - boxH - 12;
  ctx.fillStyle = "rgba(24,24,27,0.92)";
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let textY = boxY + 10;
  if (title) {
    ctx.fillStyle = "rgba(161,161,170,0.95)";
    ctx.fillText(title, boxX + 8, textY);
    textY += 14;
  }
  for (const row of rows) {
    ctx.fillStyle = row.color;
    ctx.fillRect(boxX + 8, textY - 3, 6, 6);
    ctx.fillStyle = "rgba(244,244,245,0.95)";
    ctx.fillText(`${row.name}  ${row.value}%`, boxX + 18, textY);
    textY += 14;
  }
}

export function CompareChart({
  series,
  focus,
  viewStart,
  viewSpan,
  asOf,
  onViewChange,
}: {
  series: ChartSeries[];
  focus: string | null;
  viewStart: number;
  viewSpan: number;
  asOf: string | null;
  onViewChange: (start: number, span: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const viewRef = useRef({ viewStart, viewSpan, onViewChange });
  viewRef.current = { viewStart, viewSpan, onViewChange };

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const draw = () => paint(canvas, wrap, series, focus, viewStart, viewSpan, asOf, hover);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [asOf, focus, hover, series, viewSpan, viewStart]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const plotW = Math.max(1, rect.width - PAD_L - PAD_R);
      const localX = Math.min(plotW, Math.max(0, event.clientX - rect.left - PAD_L));
      const frac = localX / plotW;
      const current = viewRef.current;
      const points = Math.max(1, ...series.map((item) => item.values.length), 1);
      const minSpan = Math.min(1, 8 / Math.max(points, 8));
      const zoom = event.deltaY > 0 ? 1.18 : 1 / 1.18;
      const span = Math.min(1, Math.max(minSpan, current.viewSpan * zoom));
      const cursor = current.viewStart + frac * current.viewSpan;
      const start = Math.min(Math.max(0, cursor - frac * span), 1 - span);
      current.onViewChange(start, span);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [series]);

  function indexAt(clientX: number) {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - PAD_L - PAD_R);
    const frac = Math.min(1, Math.max(0, (clientX - rect.left - PAD_L) / plotW));
    const points = Math.max(1, ...series.map((item) => item.values.length));
    const domain = Math.max(points - 1, 1);
    const { viewStart: start, viewSpan: span } = viewRef.current;
    return (start + frac * span) * domain;
  }

  return (
    <div
      ref={wrapRef}
      className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const wrap = wrapRef.current;
        if (!wrap) return;
        wrap.setPointerCapture(event.pointerId);
        const originX = event.clientX;
        const origin = { ...viewRef.current };
        const move = (ev: PointerEvent) => {
          const plotW = Math.max(1, wrap.clientWidth - PAD_L - PAD_R);
          const shift = ((originX - ev.clientX) / plotW) * origin.viewSpan;
          const start = Math.min(Math.max(0, origin.viewStart + shift), 1 - origin.viewSpan);
          origin.onViewChange(start, origin.viewSpan);
        };
        const up = (ev: PointerEvent) => {
          wrap.removeEventListener("pointermove", move);
          wrap.removeEventListener("pointerup", up);
          if (wrap.hasPointerCapture(ev.pointerId)) wrap.releasePointerCapture(ev.pointerId);
        };
        wrap.addEventListener("pointermove", move);
        wrap.addEventListener("pointerup", up);
      }}
      onPointerMove={(event) => {
        const wrap = wrapRef.current;
        if (!wrap || series.length === 0) return;
        const rect = wrap.getBoundingClientRect();
        setHover({
          index: Math.round(indexAt(event.clientX)),
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
