'use client';

import { useEffect } from 'react';
import { RotateCcw } from 'lucide-react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // If it's a chunk loading failure, automatically reload once
    const msg = error?.message || '';
    if (msg.includes('Loading chunk') || msg.includes('ChunkLoadError') || error?.name === 'ChunkLoadError') {
      const lastReload = sessionStorage.getItem('chunk_load_reload_ts');
      const now = Date.now();
      if (!lastReload || now - parseInt(lastReload, 10) > 8000) {
        sessionStorage.setItem('chunk_load_reload_ts', now.toString());
        window.location.reload();
      }
    }
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-pink-50 text-pink-950 font-sans">
      <div className="bg-white p-8 rounded-3xl border border-pink-200 shadow-sm max-w-md w-full text-center">
        <h2 className="text-xl font-bold text-pink-900 mb-2">Chargement en cours</h2>
        <p className="text-pink-700/80 text-sm mb-6 leading-relaxed">
          L’application a été mise à jour. Cliquez sur Actualiser pour charger la dernière version.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="inline-flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-bold px-6 py-3 rounded-2xl shadow-md transition-all active:scale-95"
        >
          <RotateCcw className="w-4 h-4" />
          Actualiser
        </button>
      </div>
    </div>
  );
}
