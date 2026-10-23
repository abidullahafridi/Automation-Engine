import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const replacements = [
  {
    file: "src/primitives/context-menu.tsx",
    generated: "    checked={checked}\n",
    reconciled: "    {...(checked === undefined ? {} : { checked })}\n"
  },
  {
    file: "src/primitives/dropdown-menu.tsx",
    generated: "    checked={checked}\n",
    reconciled: "    {...(checked === undefined ? {} : { checked })}\n"
  },
  {
    file: "src/primitives/menubar.tsx",
    generated: "    checked={checked}\n",
    reconciled: "    {...(checked === undefined ? {} : { checked })}\n"
  },
  {
    file: "src/primitives/input-otp.tsx",
    generated: "  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index]\n",
    reconciled: [
      "  const slot = inputOTPContext.slots[index]",
      "",
      "  if (!slot) return null",
      "",
      "  const { char, hasFakeCaret, isActive } = slot",
      ""
    ].join("\n")
  },
  {
    file: "src/primitives/pagination.tsx",
    generated: "import { ButtonProps, buttonVariants } from \"#ui/primitives/button\"\n",
    reconciled: [
      "import { buttonVariants } from \"#ui/primitives/button\"",
      "import type { ButtonProps } from \"#ui/primitives/button\"",
      ""
    ].join("\n")
  },
  {
    file: "src/primitives/calendar.tsx",
    generated: "import { DayButton, DayPicker, getDefaultClassNames } from \"react-day-picker\"\n",
    reconciled: [
      "import { DayPicker, getDefaultClassNames } from \"react-day-picker\"",
      "import type { DayButton } from \"react-day-picker\"",
      ""
    ].join("\n")
  },
  {
    file: "src/primitives/form.tsx",
    generated: "import * as LabelPrimitive from \"@radix-ui/react-label\"\n",
    reconciled: "import type * as LabelPrimitive from \"@radix-ui/react-label\"\n"
  },
  {
    file: "src/primitives/sonner.tsx",
    generated: [
      "  const { theme = \"system\" } = useTheme()",
      "",
      "  return (",
      "    <Sonner",
      "      theme={theme as ToasterProps[\"theme\"]}"
    ].join("\n"),
    reconciled: [
      "  const activeTheme = useTheme().theme",
      "  const theme: ToasterProps[\"theme\"] =",
      "    activeTheme === \"light\" || activeTheme === \"dark\" || activeTheme === \"system\"",
      "      ? activeTheme",
      "      : \"system\"",
      "",
      "  return (",
      "    <Sonner",
      "      theme={theme}"
    ].join("\n")
  }
];

for (const replacement of replacements) {
  const filePath = path.join(packageRoot, replacement.file);
  const source = await readFile(filePath, "utf8");
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const normalizedSource = source.replaceAll("\r\n", "\n");
  if (normalizedSource.includes(replacement.reconciled)) continue;
  if (!normalizedSource.includes(replacement.generated)) {
    throw new Error(`Unable to reconcile unexpected registry source: ${replacement.file}`);
  }
  const reconciledSource = normalizedSource.replace(replacement.generated, replacement.reconciled);
  await writeFile(filePath, reconciledSource.replaceAll("\n", lineEnding), "utf8");
}
