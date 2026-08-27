import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    // The engine is the product's core and must stay free of channel- and
    // vertical-specific concerns. Anything under lib/engine/ may depend on
    // Prisma and the shared primitives only — never on the conversation layer,
    // a channel adapter, or a customer-specific connector. Enforced here so the
    // boundary is mechanical rather than remembered.
    files: ["lib/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/conversation/*", "@/lib/channels/*", "@/lib/connectors/*"],
              message:
                "lib/engine must not import the conversation layer, a channel adapter, or a connector.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
