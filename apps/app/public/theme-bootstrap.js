(function applyAgencyAiThemeBeforePaint() {
  try {
    var mode = localStorage.getItem("openwork.themePref") || "system";
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved =
      mode === "dark" || (mode === "system" && prefersDark)
        ? "dark"
        : "light";
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  }
})();
