import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const ANALYTICS_DIR = path.join(DATA_DIR, 'analytics');
const RUNS_FILE = path.join(ANALYTICS_DIR, 'runs.json');

export interface AnalysisRunRecord {
  id: string;
  timestamp: number;
  audioSizeBytes: number;
  audioDurationSeconds?: number;
  documentSizeBytes: number;
  documentType: string;
  model: string;
  totalDurationMs: number;
  geminiDurationMs: number;
}

function ensureDir() {
  if (!fs.existsSync(ANALYTICS_DIR)) {
    fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
  }
}

export function getAnalysisHistory(): AnalysisRunRecord[] {
  try {
    ensureDir();
    if (!fs.existsSync(RUNS_FILE)) {
      return [];
    }
    const content = fs.readFileSync(RUNS_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to read analytics history:', err);
    return [];
  }
}

export function recordAnalysisRun(record: AnalysisRunRecord) {
  try {
    ensureDir();
    const history = getAnalysisHistory();
    history.push(record);
    // Keep last 50 runs
    const trimmed = history.slice(-50);
    fs.writeFileSync(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to record analysis run:', err);
  }
}

export function getEstimatedDurationMs(params: {
  audioSizeBytes: number;
  audioDurationSeconds?: number;
  documentSizeBytes: number;
  documentType: string;
  model: string;
}): { estimatedTotalMs: number; isDefault: boolean } | null {
  const history = getAnalysisHistory();
  if (history.length === 0) {
    // Aucune analyse précédente enregistrée : estimation prudente requise ("quelques minutes")
    return null;
  }

  // Filtrer les runs pertinents (même modèle ou récents)
  const matching = history.filter(r => r.model === params.model || !r.model);
  const pool = matching.length > 0 ? matching : history;

  // Calcul d'une moyenne glissante pondérée sur les 10 dernières analyses
  const recent = pool.slice(-10);
  let totalWeight = 0;
  let weightedDurationMs = 0;

  for (let i = 0; i < recent.length; i++) {
    const run = recent[i];
    // Poids croissant pour les runs plus récents
    const recencyWeight = i + 1;

    // Facteur d'échelle basé sur la taille audio et document
    let scaleRatio = 1;
    if (run.audioSizeBytes > 0 && params.audioSizeBytes > 0) {
      const audioRatio = params.audioSizeBytes / run.audioSizeBytes;
      // Amortir le ratio pour éviter les extrêmes (l'API Gemini ne met pas 10x plus de temps pour 10x la taille)
      const dampedAudioRatio = Math.pow(audioRatio, 0.6);
      scaleRatio = Math.max(0.4, Math.min(3.0, dampedAudioRatio));
    }

    const estimatedForRun = run.totalDurationMs * scaleRatio;
    weightedDurationMs += estimatedForRun * recencyWeight;
    totalWeight += recencyWeight;
  }

  const movingAverageMs = totalWeight > 0 ? weightedDurationMs / totalWeight : 120000;
  // Borner entre 20 secondes et 10 minutes
  const boundedEstimate = Math.max(20000, Math.min(600000, Math.round(movingAverageMs)));

  return {
    estimatedTotalMs: boundedEstimate,
    isDefault: false,
  };
}

export function formatETA(remainingSeconds: number | null): string {
  if (remainingSeconds === null || remainingSeconds === undefined) {
    return 'Temps restant estimé : quelques minutes';
  }

  if (remainingSeconds <= 5) {
    return 'Finalisation imminente...';
  }
  if (remainingSeconds < 15) {
    return 'Moins de 15 secondes restantes';
  }
  if (remainingSeconds < 60) {
    return `Moins d'une minute restante (~${remainingSeconds}s)`;
  }
  if (remainingSeconds <= 90) {
    return 'Environ 1 min restante';
  }

  const minutes = Math.round(remainingSeconds / 60);
  return `Environ ${minutes} min restantes`;
}
