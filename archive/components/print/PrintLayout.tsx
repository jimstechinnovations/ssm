/**
 * components/print/PrintLayout.tsx
 *
 * Presentational wrapper for the print view. No 'use client' — renders as a
 * React Server Component.
 *
 * On screen: renders children normally.
 * In print: the @media print rules in this component (injected via <style>)
 * hide all navigation chrome, stepper controls, and action buttons per
 * Requirement 9.5. The host page (app/(builder)/print/page.tsx) is also
 * expected to add its own .no-print elements for any interactive controls.
 *
 * Requirements: 9.5
 */

import React from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrintLayoutProps {
  children: React.ReactNode
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PrintLayout({ children }: PrintLayoutProps) {
  return (
    <>
      {/*
        Inject global @media print rules.
        Hides nav chrome, stepper, headers, and any element marked .no-print.
        Using a <style> tag here keeps this purely server-rendered — no JS
        hydration cost and no 'use client' required.
      */}
      <style>{`
        @media print {
          nav,
          header,
          .no-print {
            display: none !important;
          }

          body {
            background: white !important;
            color: black !important;
          }

          /* Remove default browser print margins that can clip content */
          @page {
            margin: 10mm;
          }
        }
      `}</style>

      <div className="print:bg-white">{children}</div>
    </>
  )
}

export default PrintLayout
