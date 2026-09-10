import React from 'react';

export const BRAND_ICON = '/landing/brand/boardly-icon-black-v1.svg';

export default function BrandLogo({ size = 32, wordmark = true, className = '' }) {
  return <span className={`inline-flex items-center gap-2.5 shrink-0 ${className}`}>
    <img src={BRAND_ICON} width={size} height={size} alt={wordmark ? '' : 'Boardly'} className="shrink-0" />
    {wordmark && <span className="font-bold tracking-tight">Boardly</span>}
  </span>;
}
