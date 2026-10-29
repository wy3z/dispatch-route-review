"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import styles from "./RoutePaneResizeHandle.module.css";
import {
  clampRoutePaneWidth,
  nearestRoutePaneMode,
  resolveRoutePaneMode,
} from "./workspace-layout";
import type { RoutePaneMode, RoutePaneSnapPoints } from "./workspace-layout";

type RoutePaneResizeResult = { width: number; mode: RoutePaneMode };

type UseRoutePaneResizeOptions = {
  width: number;
  mode: RoutePaneMode;
  snapPoints: RoutePaneSnapPoints;
  onResize: (result: RoutePaneResizeResult) => void;
  onResizeEnd: (result: RoutePaneResizeResult) => void;
  disabled?: boolean;
  keyboardStep?: number;
};

export function useRoutePaneResize({
  width,
  mode,
  snapPoints,
  onResize,
  onResizeEnd,
  disabled = false,
  keyboardStep = 16,
}: UseRoutePaneResizeOptions) {
  const [resizing, setResizing] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const endAtWidth = useCallback(
    (nextWidth: number) => {
      const nextMode = nearestRoutePaneMode(nextWidth, snapPoints);
      onResizeEnd({ width: snapPoints[nextMode], mode: nextMode });
    },
    [onResizeEnd, snapPoints],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = width;
      let latestWidth = width;

      cleanupRef.current?.();
      setResizing(true);

      const move = (moveEvent: globalThis.PointerEvent) => {
        latestWidth = clampRoutePaneWidth(
          startWidth + moveEvent.clientX - startX,
          snapPoints,
        );
        if (animationFrameRef.current !== null) return;
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null;
          onResize({
            width: latestWidth,
            mode: resolveRoutePaneMode(latestWidth, mode, snapPoints),
          });
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        cleanupRef.current = null;
        setResizing(false);
      };
      const up = () => {
        cleanup();
        endAtWidth(latestWidth);
      };
      const cancel = () => {
        cleanup();
        endAtWidth(startWidth);
      };

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("pointercancel", cancel, { once: true });
    },
    [disabled, endAtWidth, mode, onResize, snapPoints, width],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      let nextWidth: number | null = null;
      if (event.key === "ArrowLeft") {
        nextWidth = width - keyboardStep * (event.shiftKey ? 3 : 1);
      } else if (event.key === "ArrowRight") {
        nextWidth = width + keyboardStep * (event.shiftKey ? 3 : 1);
      } else if (event.key === "Home") {
        nextWidth = snapPoints.routes;
      } else if (event.key === "End") {
        nextWidth = snapPoints.fullscreen;
      }
      if (nextWidth === null) return;
      event.preventDefault();
      event.stopPropagation();
      const clampedWidth = clampRoutePaneWidth(nextWidth, snapPoints);
      if (event.key === "Home" || event.key === "End") {
        endAtWidth(clampedWidth);
        return;
      }
      onResizeEnd({
        width: clampedWidth,
        mode: resolveRoutePaneMode(clampedWidth, mode, snapPoints),
      });
    },
    [disabled, endAtWidth, keyboardStep, mode, onResizeEnd, snapPoints, width],
  );

  return {
    resizing,
    separatorProps: {
      role: "separator" as const,
      tabIndex: disabled ? -1 : 0,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": Math.round(snapPoints.routes),
      "aria-valuemax": Math.round(snapPoints.fullscreen),
      "aria-valuenow": Math.round(width),
      "aria-disabled": disabled || undefined,
      "data-resizing": resizing || undefined,
      onPointerDown,
      onKeyDown,
    },
  };
}

type RoutePaneResizeHandleProps = UseRoutePaneResizeOptions & {
  label?: string;
  className?: string;
};

export function RoutePaneResizeHandle({
  label = "Resize engineer routes panel",
  className,
  ...options
}: RoutePaneResizeHandleProps) {
  const { separatorProps } = useRoutePaneResize(options);
  return (
    <div
      {...separatorProps}
      className={[styles.handle, className].filter(Boolean).join(" ")}
      aria-label={label}
    />
  );
}
