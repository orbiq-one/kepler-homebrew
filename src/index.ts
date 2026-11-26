import {
  Accessory,
  Action,
  Command,
  Icon,
  LookAhead,
  definePlugin,
} from "@kepler-app/plugin-sdk";
import type {
  LookAheadItem,
  PluginContext,
  PluginListItem,
} from "@kepler-app/plugin-sdk";

type OutdatedPackage = {
  name: string;
  shortName: string;
  installed: string;
  current: string;
  kind: "formula" | "cask";
};

type BrewOutdatedPayload = {
  formulae?: Array<{
    name?: string;
    installed_versions?: string[];
    current_version?: string;
    pinned?: boolean;
  }>;
  casks?: Array<{
    name?: string;
    installed_versions?: string[];
    current_version?: string;
  }>;
};

type CachedOutdated = {
  fetchedAt: number;
  configKey: string;
  packages: OutdatedPackage[];
};

const CACHE_KEY = "outdated-cache";
const BREW_PATH_KEY = "resolved-brew-path";
const DEFAULT_BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

function shortNameOf(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

function readOptions(ctx: PluginContext) {
  const brewPath = String(ctx.settings.brewPath ?? "").trim();
  const includeCasks = ctx.settings.includeCasks !== false;
  const greedyCasks = ctx.settings.greedyCasks === true;
  const rawMinutes = Number(ctx.settings.cacheMinutes ?? 30);
  const cacheMinutes = Number.isFinite(rawMinutes) && rawMinutes >= 1 ? rawMinutes : 30;
  const terminalApp = String(ctx.settings.terminalApp ?? "terminal");
  const cardAction = String(ctx.settings.cardAction ?? "searchMode");
  return {
    brewPath,
    includeCasks,
    greedyCasks,
    terminalApp,
    cardAction,
    cacheMs: cacheMinutes * 60_000,
    configKey: `${brewPath}|${includeCasks ? 1 : 0}|${greedyCasks ? 1 : 0}`,
  };
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildTerminalAction(command: string, terminalApp: string) {
  const escaped = escapeAppleScriptString(command);
  if (terminalApp === "copy") {
    return Action.copy(command);
  }
  if (terminalApp === "iterm") {
    return Action.appleScript(
      `tell application "iTerm"\nactivate\ncreate window with default profile command "${escaped}"\nend tell`
    );
  }
  return Action.appleScript(
    `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`
  );
}

function buildArgs(includeCasks: boolean, greedyCasks: boolean): string[] {
  const args = ["outdated", "--json=v2"];
  if (!includeCasks) {
    args.push("--formula");
  } else if (greedyCasks) {
    args.push("--greedy");
  }
  return args;
}

function parseOutdated(stdout: string, includeCasks: boolean): OutdatedPackage[] {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return [];
  const parsed = JSON.parse(stdout.slice(jsonStart)) as BrewOutdatedPayload;
  const result: OutdatedPackage[] = [];

  for (const f of parsed.formulae ?? []) {
    if (!f.name || f.pinned) continue;
    const installed = Array.isArray(f.installed_versions) && f.installed_versions.length > 0
      ? f.installed_versions.join(", ")
      : "?";
    result.push({
      name: f.name,
      shortName: shortNameOf(f.name),
      installed,
      current: f.current_version ?? "?",
      kind: "formula",
    });
  }

  if (includeCasks) {
    for (const c of parsed.casks ?? []) {
      if (!c.name) continue;
      const installed = Array.isArray(c.installed_versions) && c.installed_versions.length > 0
        ? c.installed_versions.join(", ")
        : "?";
      result.push({
        name: c.name,
        shortName: shortNameOf(c.name),
        installed,
        current: c.current_version ?? "?",
        kind: "cask",
      });
    }
  }

  result.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return result;
}

async function execBrew(
  ctx: PluginContext,
  configuredPath: string,
  args: string[]
): Promise<string | null> {
  const candidates: string[] = [];
  if (configuredPath) {
    candidates.push(configuredPath);
  } else {
    const remembered = ctx.storage.get<string>(BREW_PATH_KEY);
    if (remembered) candidates.push(remembered);
    for (const p of DEFAULT_BREW_PATHS) {
      if (!candidates.includes(p)) candidates.push(p);
    }
  }

  for (const executable of candidates) {
    try {
      const res = await ctx.process.exec({
        executable,
        arguments: args,
        environment: {
          HOMEBREW_NO_AUTO_UPDATE: "1",
          HOMEBREW_NO_ENV_HINTS: "1",
        },
        timeoutMs: 7500,
      });
      if (res.exitCode === 0) {
        if (!configuredPath) {
          ctx.storage.set(BREW_PATH_KEY, executable);
        }
        return res.stdout;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function getOutdatedPackages(
  ctx: PluginContext,
  forceRefresh = false
): Promise<{ packages: OutdatedPackage[]; fetchedAt: number } | null> {
  const opts = readOptions(ctx);
  const nowMs = Date.parse(ctx.now) || Date.now();
  const cached = ctx.storage.get<CachedOutdated>(CACHE_KEY);

  if (
    !forceRefresh &&
    cached &&
    cached.configKey === opts.configKey &&
    nowMs - cached.fetchedAt < opts.cacheMs
  ) {
    return { packages: cached.packages, fetchedAt: cached.fetchedAt };
  }

  const stdout = await execBrew(
    ctx,
    opts.brewPath,
    buildArgs(opts.includeCasks, opts.greedyCasks)
  );
  if (stdout == null) {
    return cached && cached.configKey === opts.configKey
      ? { packages: cached.packages, fetchedAt: cached.fetchedAt }
      : null;
  }

  try {
    const packages = parseOutdated(stdout, opts.includeCasks);
    const entry: CachedOutdated = {
      fetchedAt: nowMs,
      configKey: opts.configKey,
      packages,
    };
    ctx.storage.set(CACHE_KEY, entry);
    return { packages, fetchedAt: nowMs };
  } catch {
    return cached ? { packages: cached.packages, fetchedAt: cached.fetchedAt } : null;
  }
}

function fingerprint(packages: OutdatedPackage[]): string {
  const input = packages.map((p) => `${p.kind}:${p.name}@${p.current}`).join("|");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function previewSubtitle(packages: OutdatedPackage[]): string {
  const names = packages.slice(0, 3).map((p) => p.shortName);
  const remaining = packages.length - names.length;
  return remaining > 0 ? `${names.join(", ")} +${remaining} more` : names.join(", ");
}

export default definePlugin({
  metadata: {
    id: "com.kepler.homebrew",
    name: "Homebrew",
    version: "1.0.0",
    author: "Leonhard Breuer",
    description: "Show outstanding Homebrew updates in Look Ahead and browse outdated packages.",
    icon: Icon.sfSymbol("shippingbox.fill"),
    permissions: ["process", "appleScript"],
    settings: [
      {
        id: "terminalApp",
        title: "Upgrade Action",
        description: "How upgrade commands are run when selected.",
        kind: "picker",
        defaultValue: "terminal",
        options: [
          { id: "terminal", title: "Open in Terminal" },
          { id: "iterm", title: "Open in iTerm" },
          { id: "copy", title: "Copy Command" },
        ],
      },
      {
        id: "cardAction",
        title: "Look Ahead Card Click",
        description: "What happens when you click or press Return on the Look Ahead card.",
        kind: "picker",
        defaultValue: "searchMode",
        options: [
          { id: "searchMode", title: "Browse Outdated Packages (/brew)" },
          { id: "upgradeAll", title: "Open Terminal with brew upgrade" },
        ],
      },
      {
        id: "includeCasks",
        title: "Include Casks",
        description: "Include outdated Homebrew casks alongside formulae.",
        kind: "toggle",
        defaultValue: true,
      },
      {
        id: "greedyCasks",
        title: "Include Auto-Updating Casks (--greedy)",
        description: "Pass --greedy when checking casks.",
        kind: "toggle",
        defaultValue: false,
      },
      {
        id: "cacheMinutes",
        title: "Refresh Interval (minutes)",
        description: "How long outdated results are cached before re-running brew.",
        kind: "number",
        defaultValue: 30,
        min: 1,
        max: 1440,
        step: 5,
      },
      {
        id: "brewPath",
        title: "Brew Executable Path",
        description: "Leave empty to auto-detect /opt/homebrew/bin/brew or /usr/local/bin/brew.",
        kind: "text",
        defaultValue: "",
      },
    ],
  },

  lookAhead: [
    LookAhead.items({
      id: "outdated",
      title: "Homebrew Updates",
      async run(ctx): Promise<LookAheadItem[]> {
        const result = await getOutdatedPackages(ctx);
        if (!result || result.packages.length === 0) return [];

        const count = result.packages.length;
        const opts = readOptions(ctx);
        const upgradeAllCmd = opts.greedyCasks ? "brew upgrade --greedy" : "brew upgrade";
        const action =
          opts.cardAction === "upgradeAll"
            ? buildTerminalAction(upgradeAllCmd, opts.terminalApp)
            : Action.searchMode("outdated");

        return [
          {
            id: `brew.outdated.${fingerprint(result.packages)}`,
            kind: "plugin",
            title: count === 1 ? "1 Brew update" : `${count} Brew updates`,
            subtitle: previewSubtitle(result.packages),
            icon: "shippingbox.fill",
            iconColor: "orange",
            priority: 40,
            action,
            dismissible: true,
          },
        ];
      },
    }),
  ],

  searchModes: [
    Command.search({
      id: "outdated",
      title: "Homebrew Updates",
      subtitle: "Browse outdated Homebrew formulae and casks",
      keywords: ["brew", "homebrew", "outdated", "updates", "upgrade"],
      icon: Icon.sfSymbol("shippingbox.fill"),
      shortcutPrefix: "brew",
      placeholder: "Filter outdated packages (type 'refresh' to recheck)…",
      async run(query, ctx): Promise<PluginListItem[]> {
        const forceRefresh = query.normalized === "refresh";
        const result = await getOutdatedPackages(ctx, forceRefresh);

        if (!result) {
          return [
            {
              id: "brew-unavailable",
              title: "Homebrew not found",
              subtitle: "Set the brew executable path in Homebrew plugin settings.",
              icon: Icon.sfSymbol("exclamationmark.triangle.fill"),
            },
          ];
        }

        const filter = forceRefresh ? "" : query.normalized;
        const packages = filter
          ? result.packages.filter(
              (p) =>
                p.name.toLowerCase().includes(filter) ||
                p.shortName.toLowerCase().includes(filter) ||
                p.kind.includes(filter)
            )
          : result.packages;

        if (result.packages.length === 0) {
          return [
            {
              id: "brew-up-to-date",
              title: "Homebrew is up to date",
              subtitle: "All installed packages are on their latest version.",
              icon: Icon.sfSymbol("checkmark.circle.fill"),
            },
          ];
        }

        const items: PluginListItem[] = [];
        const opts = readOptions(ctx);
        const upgradeAllCmd = opts.greedyCasks ? "brew upgrade --greedy" : "brew upgrade";
        const actionBadge = opts.terminalApp === "copy" ? "Copy" : "Run in Terminal";

        if (!filter || "upgrade all".includes(filter)) {
          items.push({
            id: "brew-upgrade-all",
            title: `Upgrade All (${result.packages.length})`,
            subtitle: upgradeAllCmd,
            icon: Icon.sfSymbol("arrow.down.circle.fill"),
            accessory: Accessory.badge(actionBadge),
            action: buildTerminalAction(upgradeAllCmd, opts.terminalApp),
          });
        }

        for (const pkg of packages) {
          const cmd =
            pkg.kind === "cask"
              ? `brew upgrade --cask ${pkg.name}`
              : `brew upgrade ${pkg.name}`;
          const versionText = `${pkg.installed} → ${pkg.current}`;
          const subtitle =
            pkg.shortName !== pkg.name ? `${versionText} · ${pkg.name}` : versionText;

          items.push({
            id: `brew-${pkg.kind}-${pkg.name}`,
            title: pkg.shortName,
            subtitle,
            icon: Icon.sfSymbol(pkg.kind === "cask" ? "macwindow" : "terminal"),
            accessory: Accessory.badge(pkg.kind === "cask" ? "Cask" : "Formula", true),
            action: buildTerminalAction(cmd, opts.terminalApp),
          });
        }

        return items;
      },
    }),
  ],
});
