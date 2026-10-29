import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const retiredRuntimeModules = {
  group: [
    "**/draft-*",
    "**/scheduler-store",
    "**/timefold-export",
    "**/travel-matrix",
    "**/travel-matrix-client",
  ],
  message: "This retired scheduling/export runtime must not be reintroduced.",
};

const noSourceInspection = {
  paths: [
    {
      name: "node:fs",
      message:
        "Behavioural tests must exercise exported behaviour instead of matching implementation source text.",
    },
    {
      name: "node:fs/promises",
      message:
        "Behavioural tests must exercise exported behaviour instead of matching implementation source text.",
    },
  ],
};

const apiFailureAuditRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      missingBoundary:
        "Non-health API handlers must return through auditApiRequest so server-produced failures are recorded.",
    },
  },
  create(context) {
    const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    let auditLocalName = null;

    function containsAuditCall(node) {
      if (!node || typeof node !== "object") return false;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === auditLocalName
      ) {
        return true;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "parent") continue;
        if (Array.isArray(value)) {
          if (value.some((entry) => containsAuditCall(entry))) return true;
        } else if (value && typeof value === "object" && "type" in value) {
          if (containsAuditCall(value)) return true;
        }
      }
      return false;
    }

    function reportIfUnwrapped(node, name) {
      if (!httpMethods.has(name)) return;
      if (!auditLocalName || !containsAuditCall(node)) {
        context.report({ node, messageId: "missingBoundary" });
      }
    }

    return {
      ImportDeclaration(node) {
        if (
          typeof node.source.value !== "string" ||
          node.source.value !== "@/modules/access/server"
        ) {
          return;
        }
        const auditImport = node.specifiers.find(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "auditApiRequest",
        );
        if (auditImport) auditLocalName = auditImport.local.name;
      },
      "Program:exit"(program) {
        for (const statement of program.body) {
          if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) {
            continue;
          }
          if (statement.declaration.type === "FunctionDeclaration") {
            reportIfUnwrapped(
              statement.declaration,
              statement.declaration.id?.name ?? "",
            );
            continue;
          }
          if (statement.declaration.type === "VariableDeclaration") {
            for (const declaration of statement.declaration.declarations) {
              if (declaration.id.type !== "Identifier") continue;
              reportIfUnwrapped(declaration, declaration.id.name);
            }
          }
        }
      },
    };
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["app/**/*.{ts,tsx}", "modules/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}", "workflows/**/*.ts", "platform/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [retiredRuntimeModules] },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "proxy.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [retiredRuntimeModules, {
          group: ["**"],
          importNames: ["requestCacheRefresh", "claimCacheRefreshJobs", "storeCacheSnapshot", "releaseCacheRefreshJob"],
          message: "Web entry points cannot import the cache refresh writer.",
        }],
      }],
    },
  },
  {
    files: ["app/api/**/route.ts"],
    ignores: ["app/api/health/**/route.ts"],
    plugins: {
      architecture: {
        rules: {
          "api-failure-audit": apiFailureAuditRule,
        },
      },
    },
    rules: {
      "architecture/api-failure-audit": "error",
    },
  },
  {
    files: [
      "tests/cache-freshness.test.ts",
      "tests/cache-policy.test.ts",
      "tests/dispatch-review*.test.ts",
      "tests/map-marker-design.test.ts",
      "tests/page-permissions.test.ts",
      "tests/planning-demand.test.ts",
      "tests/ready-to-book.test.ts",
      "tests/rendered-html.test.mjs",
      "tests/route-suggestion-context.test.ts",
      "tests/worker-cache.test.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", noSourceInspection],
    },
  },
]);

export default eslintConfig;
