import { Code2 } from "lucide-react";
import { type ComponentType } from "react";
import {
  type SimpleIcon,
  siAnthropic,
  siCline,
  siCursor,
  siDeepseek,
  siGithubcopilot,
  siGooglegemini,
  siKimi,
  siMistralai,
  siOpencode,
  siQwen,
  siTrae,
  siWarp,
  siX,
} from "simple-icons";

type BrandIcon = ComponentType<{ className?: string }>;

interface HarnessPresentation {
  label: string;
  icon: BrandIcon;
  groupId?: string;
  runtimes?: Record<string, { label: string }>;
}

const fallbackPresentation: HarnessPresentation = {
  label: "",
  icon: Code2,
};

/**
 * The scanner owns machine facts (ids, status, paths, and surfaces). This registry owns every
 * human-facing identity used by both Detection and the sidebar, so one provider cannot be named
 * or branded differently between screens.
 */
export const harnessRegistry: Record<string, HarnessPresentation> = {
  codex: {
    label: "OpenAI",
    icon: OpenAILogo,
    runtimes: {
      "codex-local": { label: "Codex" },
    },
  },
  claude: {
    label: "Claude",
    icon: brandIcon(siAnthropic),
    runtimes: {
      "claude-code": { label: "Claude Code" },
      "claude-desktop-chat": { label: "Claude Desktop" },
    },
  },
  cursor: catalog("cursor", "Cursor", brandIcon(siCursor), "Cursor Agent"),
  opencode: catalog("opencode", "OpenCode", brandIcon(siOpencode), "OpenCode CLI"),
  "deepseek-harness": catalog(
    "deepseek-harness",
    "DeepSeek",
    brandIcon(siDeepseek),
    "DeepSeek Harness",
    "deepseek",
  ),
  "gemini-cli": catalog("gemini-cli", "Gemini", brandIcon(siGooglegemini), "Gemini CLI"),
  pi: catalog("pi", "Pi", monogramIcon("PI")),
  openhands: catalog("openhands", "OpenHands", monogramIcon("OH")),
  "open-interpreter": catalog("open-interpreter", "Open Interpreter", monogramIcon("OI")),
  cline: catalog("cline", "Cline", brandIcon(siCline)),
  warp: catalog("warp", "Warp", brandIcon(siWarp)),
  goose: catalog("goose", "Goose", monogramIcon("G")),
  aider: catalog("aider", "Aider", monogramIcon("A")),
  codewhale: catalog("codewhale", "Codewhale", monogramIcon("CW")),
  continue: catalog("continue", "Continue", monogramIcon("C")),
  "deepseek-reasonix": catalog(
    "deepseek-reasonix",
    "DeepSeek",
    brandIcon(siDeepseek),
    "DeepSeek Reasonix",
    "deepseek",
  ),
  "gpt-pilot": catalog("gpt-pilot", "GPT Pilot", monogramIcon("GP")),
  "oh-my-pi": catalog("oh-my-pi", "OH-MY-PI", monogramIcon("OP")),
  "deep-agents-code": catalog(
    "deep-agents-code",
    "Deep Agents",
    monogramIcon("DA"),
    "Deep Agents Code",
  ),
  crush: catalog("crush", "Crush", monogramIcon("CR")),
  "qwen-code": catalog("qwen-code", "Qwen", brandIcon(siQwen), "Qwen Code"),
  "kilo-code": catalog("kilo-code", "Kilo Code", monogramIcon("KI")),
  "grok-build": catalog("grok-build", "Grok", brandIcon(siX), "Grok Build", "grok"),
  dyad: catalog("dyad", "Dyad", monogramIcon("DY")),
  "swe-agent": catalog("swe-agent", "SWE-agent", monogramIcon("SW")),
  "prime-agent": catalog("prime-agent", "Prime Agent", monogramIcon("PA")),
  devika: catalog("devika", "Devika", monogramIcon("D")),
  jcode: catalog("jcode", "JCode", monogramIcon("JC")),
  bolt: catalog("bolt", "Bolt", monogramIcon("B")),
  deepcode: catalog("deepcode", "DeepCode", monogramIcon("DC")),
  plandex: catalog("plandex", "Plandex", monogramIcon("P")),
  "mimo-code": catalog("mimo-code", "MiMo Code", monogramIcon("MI")),
  "trae-agent": catalog("trae-agent", "Trae", brandIcon(siTrae), "Trae Agent"),
  codebuff: catalog("codebuff", "Codebuff", monogramIcon("CB")),
  "kimi-code-cli": catalog("kimi-code-cli", "Kimi", brandIcon(siKimi), "Kimi Code CLI"),
  "claude-engineer": catalog(
    "claude-engineer",
    "Claude",
    brandIcon(siAnthropic),
    "Claude Engineer",
    "claude",
  ),
  "github-copilot-cli": catalog(
    "github-copilot-cli",
    "GitHub Copilot",
    brandIcon(siGithubcopilot),
    "GitHub Copilot CLI",
  ),
  "open-swe": catalog("open-swe", "Open SWE", monogramIcon("OS")),
  forgecode: catalog("forgecode", "ForgeCode", monogramIcon("FC")),
  stagewise: catalog("stagewise", "Stagewise", monogramIcon("ST")),
  opencursor: catalog("opencursor", "OpenCursor", monogramIcon("OC")),
  melty: catalog("melty", "Melty", monogramIcon("M")),
  kodu: catalog("kodu", "Kodu", monogramIcon("KO")),
  "mistral-vibe": catalog("mistral-vibe", "Mistral", brandIcon(siMistralai), "Mistral Vibe"),
  gptme: catalog("gptme", "gptme", monogramIcon("GM")),
  "command-code": catalog("command-code", "Command Code", monogramIcon("CC")),
  "grok-cli": catalog("grok-cli", "Grok", brandIcon(siX), "Grok CLI", "grok"),
  devon: catalog("devon", "Devon", monogramIcon("DE")),
  "letta-code": catalog("letta-code", "Letta", monogramIcon("L"), "Letta Code"),
  autocoderover: catalog("autocoderover", "AutoCodeRover", monogramIcon("AR")),
};

export function getFamilyPresentation(familyId: string, fallbackLabel: string) {
  const presentation = harnessRegistry[familyId] ?? fallbackPresentation;

  return {
    ...presentation,
    label: presentation.label || fallbackLabel,
  };
}

export function getRuntimePresentation(familyId: string, runtimeId: string, fallbackLabel: string) {
  return harnessRegistry[familyId]?.runtimes?.[runtimeId] ?? { label: fallbackLabel };
}

function catalog(
  id: string,
  label: string,
  icon: BrandIcon,
  runtimeLabel = label,
  groupId?: string,
): HarnessPresentation {
  return {
    label,
    icon,
    groupId,
    runtimes: {
      [`${id}-runtime`]: { label: runtimeLabel },
    },
  };
}

function brandIcon(icon: SimpleIcon): BrandIcon {
  return function BrandIcon({ className }) {
    return (
      <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
        <path d={icon.path} />
      </svg>
    );
  };
}

function monogramIcon(label: string): BrandIcon {
  return function MonogramIcon({ className }) {
    return (
      <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
        <rect fill="currentColor" height="22" opacity="0.14" rx="5" width="22" x="1" y="1" />
        <text
          dominantBaseline="central"
          fill="currentColor"
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
          fontSize={label.length > 1 ? "8" : "11"}
          fontWeight="700"
          textAnchor="middle"
          x="12"
          y="12"
        >
          {label}
        </text>
      </svg>
    );
  };
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}
