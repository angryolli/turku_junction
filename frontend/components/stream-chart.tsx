"use client";

import { memo, useEffect, useLayoutEffect, useRef } from "react";

export type ChartMark = {
  index: number;
  level: "yellow" | "red";
};

type Props = {
  values: number[];
  tick?: number;
  className?: string;
  limit?: number;
  accent?: string;
  marks?: ChartMark[];
};

function seriesEqual(a: number[], b: number[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function marksEqual(a: ChartMark[] | undefined, b: ChartMark[] | undefined) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].index !== b[i].index || a[i].level !== b[i].level) return false;
  }
  return true;
}

function niceNum(range: number, round: boolean) {
  const exp = Math.floor(Math.log10(Math.max(range, 1e-9)));
  const frac = range / 10 ** exp;
  let nice: number;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * 10 ** exp;
}

function niceScale(lo: number, hi: number, count = 3) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const range = niceNum(hi - lo, false);
  const step = niceNum(range / Math.max(count - 1, 1), true);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 0.5; v += step) ticks.push(v);
  return { min, max, ticks };
}

function formatTick(n: number) {
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function paint(
  canvas: HTMLCanvasElement,
  wrap: HTMLDivElement,
  series: number[],
  limit: number | undefined,
  accent: string,
  marks: ChartMark[],
) {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  const w = Math.max(1, wrap.clientWidth);
  const h = Math.max(1, wrap.clientHeight);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 28;
  const padR = 8;
  const padT = 6;
  const padB = 14;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (limit !== undefined) {
    lo = Math.min(lo, limit);
    hi = Math.max(hi, limit);
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const padY = Math.max((hi - lo) * 0.2, 1e-6);
  const scale = niceScale(lo - padY, hi + padY);
  const span = scale.max - scale.min || 1;
  const n = Math.max(series.length - 1, 1);
  const xOf = (i: number) => padL + (i / n) * plotW;
  const yOf = (v: number) => padT + (1 - (v - scale.min) / span) * plotH;

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (const t of scale.ticks) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  for (const mark of marks) {
    const x = Math.round(xOf(mark.index)) + 0.5;
    ctx.beginPath();
    ctx.strokeStyle = mark.level === "red" ? "rgb(248, 113, 113)" : "rgb(251, 191, 36)";
    ctx.lineWidth = 1;
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  if (series.length) {
    ctx.moveTo(xOf(0), yOf(series[0]));
    for (let i = 1; i < series.length; i++) ctx.lineTo(xOf(i), yOf(series[i]));
    ctx.stroke();
  }

  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "rgba(161,161,170,0.9)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of scale.ticks) ctx.fillText(formatTick(t), padL - 4, yOf(t));
}

export const StreamChart = memo(
  function StreamChart({
    values,
    className = "",
    limit,
    accent = "rgb(82, 82, 91)",
    marks,
  }: Props) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const visibleRef = useRef(true);
    const valuesRef = useRef(values);
    const limitRef = useRef(limit);
    const accentRef = useRef(accent);
    const marksRef = useRef(marks);
    valuesRef.current = values;
    limitRef.current = limit;
    accentRef.current = accent;
    marksRef.current = marks;

    const draw = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas || !visibleRef.current) return;
      paint(
        canvas,
        wrap,
        valuesRef.current,
        limitRef.current,
        accentRef.current,
        marksRef.current ?? [],
      );
    };

    useEffect(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const io = new IntersectionObserver(
        ([entry]) => {
          visibleRef.current = entry.isIntersecting;
          if (entry.isIntersecting) draw();
        },
        { rootMargin: "160px" },
      );
      io.observe(wrap);
      const ro = new ResizeObserver(() => draw());
      ro.observe(wrap);
      return () => {
        io.disconnect();
        ro.disconnect();
      };
    }, []);

    useLayoutEffect(() => {
      draw();
    }, [values, limit, accent, marks]);

    return (
      <div ref={wrapRef} className={`relative w-full ${className}`}>
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
    );
  },
  (prev, next) =>
    prev.className === next.className &&
    prev.limit === next.limit &&
    prev.accent === next.accent &&
    prev.tick === next.tick &&
    seriesEqual(prev.values, next.values) &&
    marksEqual(prev.marks, next.marks),
);
