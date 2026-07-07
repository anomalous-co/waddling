/**
 * Agent brand marks for the landing carousel. Copied verbatim from the
 * anomalous.computer SurfaceIcons set — monochrome glyphs that render in
 * `currentColor` so the callsite controls the color. Simplified/stylized
 * marks for recognition at ~28px, not pixel-perfect trademark reproductions.
 */

import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'xmlns' | 'viewBox'> & {
  readonly size?: number;
};

function baseSvgProps({ size = 18, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    xmlns: 'http://www.w3.org/2000/svg',
    fill: 'currentColor',
    ...rest,
  };
}

// ─── Claude ───────────────────────────────────────────────────────────────

export function ClaudeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...baseSvgProps(props)}>
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

// ─── Cursor — hexagonal mark ──────────────────────────────────────────────

export function CursorIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...baseSvgProps(props)}>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

// ─── Codex — rosette outline with a `>_` terminal mark ────────────────────

export function CodexIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...baseSvgProps(props)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2.5 C15 4 19 5 21.5 8 C20 11 19 15 21.5 17.5 C19 20 15 20 12 21.5 C9 20 5 20 2.5 17.5 C5 15 4 11 2.5 8 C5 5 9 4 12 2.5 Z" />
      <polyline points="9,10 11.5,12 9,14" />
      <line x1="13" y1="15" x2="16" y2="15" />
    </svg>
  );
}

// ─── Gemini — four-point star (simplified) ────────────────────────────────

export function GeminiIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      {...baseSvgProps(props)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2L14.5 8.5L21 11L14.5 13.5L12 20L9.5 13.5L3 11L9.5 8.5Z" />
    </svg>
  );
}

// ─── OpenCode — single square-bracket "O" mark ────────────────────────────

export function OpenCodeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" {...baseSvgProps(props)}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </svg>
  );
}

// ─── Pi — two-path mark ───────────────────────────────────────────────────

export function PiIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 800 800" {...baseSvgProps(props)}>
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}
