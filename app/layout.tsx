import type {Metadata} from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Co-Ordo',
  description: 'Actualisez vos fiches de cours automatiquement à partir d\'enregistrements audio.',
  openGraph: {
    title: 'Co-Ordo',
    description: 'Actualisez vos fiches de cours automatiquement à partir d\'enregistrements audio.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Co-Ordo',
    description: 'Actualisez vos fiches de cours automatiquement à partir d\'enregistrements audio.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="fr">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                function handleChunkError(errStr) {
                  if (typeof errStr === 'string' && (errStr.indexOf('Loading chunk') !== -1 || errStr.indexOf('ChunkLoadError') !== -1)) {
                    var last = sessionStorage.getItem('chunk_err_reload');
                    var now = Date.now();
                    if (!last || now - parseInt(last, 10) > 8000) {
                      sessionStorage.setItem('chunk_err_reload', now.toString());
                      window.location.reload();
                    }
                  }
                }
                window.addEventListener('error', function(e) {
                  if (e && e.message) handleChunkError(e.message);
                });
                window.addEventListener('unhandledrejection', function(e) {
                  var r = e && (e.reason && e.reason.message ? e.reason.message : (typeof e.reason === 'string' ? e.reason : ''));
                  if (r) handleChunkError(r);
                });
              })();
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
