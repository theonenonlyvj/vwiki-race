/** An abstract map of connections, not a hint or a playable challenge route. */
export default function ConnectionAtlas() {
  return (
    <svg className="connection-atlas" viewBox="0 0 540 340" fill="none" aria-hidden="true" focusable="false">
      <g className="atlas-grid" stroke="currentColor" strokeWidth="0.6">
        <ellipse cx="280" cy="174" rx="220" ry="132" transform="rotate(-18 280 174)" />
        <ellipse cx="280" cy="174" rx="152" ry="132" transform="rotate(-18 280 174)" />
        <ellipse cx="280" cy="174" rx="74" ry="132" transform="rotate(-18 280 174)" />
        <path d="M67 163C181 211 381 169 478 82M72 216C218 264 415 199 495 135M113 98C261 133 381 94 417 62M148 292C303 302 442 231 466 203" />
      </g>
      <g className="atlas-trails" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 7">
        <path d="M93 228C100 107 204 54 262 87S287 289 412 247" />
        <path d="M121 148C265 305 302 50 445 116" />
      </g>
      <path className="atlas-route-shadow" d="M91 225C157 235 159 138 234 143S295 233 348 189S378 80 448 97" strokeWidth="15" strokeLinecap="round" />
      <path className="atlas-route" d="M91 225C157 235 159 138 234 143S295 233 348 189S378 80 448 97" strokeWidth="3" strokeLinecap="round" />
      <g className="atlas-stations" strokeWidth="2">
        <circle cx="91" cy="225" r="10" /><circle cx="234" cy="143" r="7" />
        <circle cx="348" cy="189" r="7" /><circle cx="448" cy="97" r="11" />
      </g>
      <g className="atlas-orbits" stroke="currentColor">
        <circle cx="91" cy="225" r="21" /><circle cx="448" cy="97" r="23" />
        <circle cx="448" cy="97" r="34" strokeDasharray="1 5" />
      </g>
      <g className="atlas-page" transform="translate(142 58) rotate(-12)">
        <rect width="57" height="69" rx="8" /><path d="M13 17H43M13 26H35M13 35H43M13 44H28M13 53H37" />
      </g>
      <g className="atlas-page atlas-page-secondary" transform="translate(373 220) rotate(13)">
        <rect width="51" height="62" rx="8" /><path d="M12 16H39M12 25H31M12 34H39M12 43H27" />
      </g>
      <g className="atlas-sparks" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M303 52V64M297 58H309M203 253V265M197 259H209M465 207V219M459 213H471" />
        <circle cx="78" cy="120" r="3" /><circle cx="313" cy="289" r="3" />
      </g>
    </svg>
  );
}
