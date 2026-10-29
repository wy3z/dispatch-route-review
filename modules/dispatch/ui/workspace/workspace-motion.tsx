"use client";

import { MotionConfig, useReducedMotion } from "motion/react";
import type { MotionConfigProps, Transition } from "motion/react";
import type { ReactNode } from "react";

const workspaceMotionTokens = {
  spring: {
    type: "spring",
    stiffness: 440,
    damping: 38,
    mass: 0.82,
  } satisfies Transition,
  panel: {
    type: "spring",
    stiffness: 480,
    damping: 40,
    mass: 0.78,
  } satisfies Transition,
  reduced: { duration: 0 } satisfies Transition,
} as const;

/** Tool content is attached to the map toolbar, so it reveals from the shared
 * seam instead of scaling like an independent floating card. */
export const workspaceDockPanelMotion = {
  initial: "initial",
  animate: "animate",
  exit: "exit",
  variants: {
    initial: {
      opacity: 0,
      y: -10,
      clipPath: "inset(0% 0% 100% 0% round 0 0 16px 16px)",
    },
    animate: {
      opacity: 1,
      y: 0,
      clipPath: "inset(0% 0% 0% 0% round 0 0 16px 16px)",
    },
    exit: {
      opacity: 0,
      y: -8,
      clipPath: "inset(0% 0% 100% 0% round 0 0 16px 16px)",
    },
  },
} as const;

export function useWorkspaceMotionTransition(
  transition: Transition = workspaceMotionTokens.panel,
) {
  const reducedMotion = useReducedMotion() ?? false;
  return reducedMotion ? workspaceMotionTokens.reduced : transition;
}

type WorkspaceMotionProviderProps = {
  children: ReactNode;
  reducedMotion?: MotionConfigProps["reducedMotion"];
};

export function WorkspaceMotionProvider({
  children,
  reducedMotion = "user",
}: WorkspaceMotionProviderProps) {
  return (
    <MotionConfig
      reducedMotion={reducedMotion}
      transition={workspaceMotionTokens.spring}
    >
      {children}
    </MotionConfig>
  );
}
