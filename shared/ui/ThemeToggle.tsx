"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("dispatch-route-review.theme");
    const enabled = saved === "dark";
    document.documentElement.dataset.theme = enabled ? "dark" : "light";
    const frame = window.requestAnimationFrame(() => setDarkMode(enabled));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function toggleTheme() {
    const enabled = !darkMode;
    document.documentElement.dataset.theme = enabled ? "dark" : "light";
    setDarkMode(enabled);
    window.localStorage.setItem(
      "dispatch-route-review.theme",
      enabled ? "dark" : "light",
    );
  }

  return (
    <button
      className="theme-toggle"
      aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
    >
      {darkMode ? (
        <svg
          className="theme-sun"
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle cx="12" cy="12" r="4.25" fill="currentColor" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.05 5.05l1.55 1.55M17.4 17.4l1.55 1.55M18.95 5.05l-1.55 1.55M6.6 17.4l-1.55 1.55"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg
          className="theme-moon"
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5 8.6 8.6 0 1 0 20.5 14.3Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
