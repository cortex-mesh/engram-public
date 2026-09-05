import { AppearanceToggle } from "@/components/auth/appearance-toggle";
import type { BrandTheme } from "@/lib/auth-brand-theme";
import { cn } from "@/lib/utils";

interface AuthShellProps {
  children?: React.ReactNode;
  brandTheme?: BrandTheme;
  brandName?: string;
  brandTagline?: string;
  supportingCopy?: string;
  className?: string;
  showMeshFamily?: boolean;
  brandLogoUrl?: string | null;
}

const MESH_FAMILY_PRODUCTS = ["Synapse", "Thoughts", "Pulse"];

function MeshAmbient() {
  return (
    <div className="mesh-ambient" aria-hidden="true">
      <svg
        className="mesh-ambient__layer mesh-ambient__layer--a"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
      >
        <polyline className="mesh-ambient__dim" points="120,140 210,90 300,160" />
        <polyline className="mesh-ambient__dim" points="520,80 610,150 560,240" />
        <polyline className="mesh-ambient__dim" points="140,420 240,470 200,540" />
        <polyline className="mesh-ambient__dim" points="640,380 700,460 620,500" />
        <circle className="mesh-ambient__dim" cx="120" cy="140" r="2" />
        <circle className="mesh-ambient__dim" cx="300" cy="160" r="1.5" />
        <circle className="mesh-ambient__dim" cx="520" cy="80" r="2.5" />
        <circle
          className="mesh-ambient__dim mesh-ambient__node--accent twinkle"
          cx="610"
          cy="150"
          r="3"
        />
        <circle className="mesh-ambient__dim" cx="200" cy="540" r="2" />
        <circle
          className="mesh-ambient__dim mesh-ambient__node--human twinkle twinkle--late"
          cx="700"
          cy="460"
          r="2.5"
        />
      </svg>
      <svg
        className="mesh-ambient__layer mesh-ambient__layer--b"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
      >
        <polyline className="mesh-ambient__dim" points="380,60 440,120 500,70" />
        <polyline className="mesh-ambient__dim" points="80,300 150,340 110,400" />
        <polyline className="mesh-ambient__dim" points="660,260 720,320 680,380" />
        <circle className="mesh-ambient__dim" cx="380" cy="60" r="2" />
        <circle className="mesh-ambient__dim" cx="500" cy="70" r="1.5" />
        <circle className="mesh-ambient__dim twinkle" cx="80" cy="300" r="2.5" />
        <circle className="mesh-ambient__dim" cx="110" cy="400" r="2" />
        <circle className="mesh-ambient__dim twinkle twinkle--late" cx="720" cy="320" r="3" />
      </svg>
    </div>
  );
}

function MeshMark() {
  return (
    <svg viewBox="0 0 64 64" className="mesh-mark">
      <circle cx="32" cy="32" r="14" className="mesh-mark__ring" />
      <line x1="32" y1="32" x2="33" y2="15" className="mesh-mark__line" />
      <line x1="32" y1="32" x2="49" y2="33" className="mesh-mark__line" />
      <line x1="32" y1="32" x2="17" y2="46" className="mesh-mark__line" />
      <circle cx="32" cy="32" r="4" className="mesh-mark__core" />
      <circle cx="33" cy="15" r="2.5" className="mesh-mark__sat" />
      <circle
        cx="49"
        cy="33"
        r="2.5"
        className="mesh-mark__sat mesh-mark__sat--b mesh-mark__sat--accent"
      />
      <circle cx="17" cy="46" r="2.5" className="mesh-mark__sat" />
    </svg>
  );
}

export function AuthShell({
  children,
  brandTheme = "engram",
  brandName = "CORTEX",
  brandTagline = "One door into the mesh.",
  supportingCopy = "Access your organization's products from one hosted entry point.",
  className,
  showMeshFamily = false,
  brandLogoUrl = null,
}: AuthShellProps) {
  const isTradepost = brandTheme === "tradepost";
  const isCiteTheMove = brandTheme === "citethemove";
  const hasBrandedWordmark = isTradepost || isCiteTheMove;

  return (
    <div className={cn("mesh-auth-shell", className)} data-brand-theme={brandTheme}>
      {!hasBrandedWordmark && <MeshAmbient />}
      <AppearanceToggle />
      <div className="mesh-auth-shell__hero">
        {isTradepost ? (
          <div className="mesh-auth-shell__tradepost-wordmark" aria-label="CCG Tradepost">
            <span className="mesh-auth-shell__tradepost-mark" aria-hidden="true" />
            <span>CCG TRADEPOST</span>
          </div>
        ) : isCiteTheMove ? (
          <div className="mesh-auth-shell__citethemove-wordmark" aria-label="Cite the Move">
            <span className="mesh-auth-shell__citethemove-mark" aria-hidden="true" />
            <span>CITE THE MOVE</span>
          </div>
        ) : (
          <div className="mesh-auth-shell__mark mesh-enter" aria-hidden="true">
            {brandLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brandLogoUrl} alt="" className="mesh-auth-shell__mark-logo" />
            ) : (
              <MeshMark />
            )}
          </div>
        )}
        <div
          className={cn(
            "space-y-2 text-center",
            !hasBrandedWordmark && "mesh-enter mesh-enter--2",
          )}
        >
          <p className="mesh-auth-shell__brand">{brandName}</p>
          <div className="space-y-1">
            <p className="mesh-auth-shell__headline text-lg font-medium text-foreground">
              {brandTagline}
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              {supportingCopy}
            </p>
          </div>
          {showMeshFamily && !hasBrandedWordmark && (
            <p className="mesh-family-row">
              <span className="sr-only">CORTEX mesh products: </span>
              {MESH_FAMILY_PRODUCTS.map((product, index) => (
                <span key={product} className="mesh-family-row__item">
                  {index > 0 && <span className="mesh-family-row__dot" aria-hidden="true" />}
                  {product}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      <div
        className={cn("mesh-auth-shell__card", !hasBrandedWordmark && "mesh-enter mesh-enter--3")}
      >
        {children}
      </div>
    </div>
  );
}
