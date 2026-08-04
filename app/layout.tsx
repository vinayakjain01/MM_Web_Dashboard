import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mahima Mahajan — Dispatch & Fulfilment Studio',
  description: 'Dispatch & fulfilment studio — live order dashboard',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* next/font/google can't express Fraunces' opsz axis range the prototype relies on;
            this is the App Router root layout (loads once for the whole app, not per-page),
            so the usual pages-router "custom font" caveat doesn't apply here. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Manrope:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
