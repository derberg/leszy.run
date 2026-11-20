// A club's logo on a white tile, always whole: `object-contain`, never cropped, whatever its
// proportions (ZATYRANI's is 512x121). White because most club logos are dark on a transparent
// background and vanish on the dark theme; the same tile as the partners' logos (PartnerLogos).
// The settings' upload preview uses it too, so the owner sees the logo as the event page shows it.

const SIZES = {
  md: 'h-16 min-w-[96px] max-w-[220px] px-3 py-2',
  header: 'h-12 min-w-[48px] max-w-[160px] px-2 py-1',
  sm: 'h-10 min-w-[40px] max-w-[120px] px-1.5 py-1',
}

/** @param {{ src: string, alt?: string, size?: 'md'|'header'|'sm', className?: string, testId?: string }} props */
export default function ClubLogoTile({ src, alt = '', size = 'md', className = '', testId }) {
  return (
    <span className={`flex items-center justify-center bg-white border border-apex-border shrink-0 ${SIZES[size]} ${className}`} data-testid={testId}>
      <img src={src} alt={alt} loading="lazy" className="block max-h-full max-w-full object-contain" />
    </span>
  )
}
