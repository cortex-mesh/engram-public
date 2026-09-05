import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: ["src/generated/**", "coverage/**", ".open-next/**", "infra/cdk/cdk.out/**"],
  },
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "react-hooks/error-boundaries": "off",
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
