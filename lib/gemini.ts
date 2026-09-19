import { GoogleGenAI } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { JobProgress, Suggestion } from '@/lib/db';

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey || '' });

const FLASH_MODEL = 'gemini-3.8-flash';
const PRO_MODEL = 'gemini-3.1-pro-preview';
const TOTAL_TIMEOUT_MS = 20 * 60 * 1000;
const FILE_READY_TIMEOUT_MS = 3 * 60 * 1000;
const FLASH_TIMEOUT_MS = 12 * 60 * 1000;
const PRO_TIMEOUT_MS = 4 * 60 * 1000;

type Candidate = {
  targetBlock?: string;
  proposedText?: string;
  originalText?: string;
  passageText?: string;
  reason?: string;
  questionOrIssue?: string;
  audioEvidence?: string;
  confidence?: number;
};

type FlashResult = {
  courseMatch?: {
    sameCourse?: boolean;
    confidence?: number;
    reason?: string;
    matchedTopics?: string[];
  };
  candidateAdditions?: Candidate[];
  candidateDeletions?: Candidate[];
  candidateModifications?: Candidate[];
  uncertainPassages?: Candidate[];
};

type ProItem = Candidate & {
  type?: 'ADD' | 'DELETE' | 'REPLACE' | 'VERIFY' | 'REJECT';
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonObject<T>(raw: string): T {
  const cleaned = (raw || '')
    .replace(/^\`\`\`json\s*/i, '')
    .replace(/^\`\`\`\s*/i, '')
    .replace(/\`\`\`\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1)) as T;
    throw new Error('Réponse IA non structurée.');
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function confidence(value: unknown, fallback = 70) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : fallback;
}

function evidence(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatEta(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export async function processCourseAudio(
  geminiFileName: string,
  geminiFileUri: string,
  geminiMimeType: string,
  docxText: { stableId: string; text: string }[],
  onProgress: (progress: JobProgress) => void,
  metadata?: {
    jobId?: string;
    audioSizeBytes?: number;
    audioDurationSeconds?: number;
    documentSizeBytes?: number;
    documentType?: string;
  }
): Promise<Suggestion[]> {
  if (!apiKey) throw new Error('La clé Gemini du serveur est absente.');
  if (!geminiFileName || !geminiFileUri || !geminiMimeType) {
    throw new Error("Le fichier audio n'a pas été finalisé correctement. Veuillez renvoyer l'audio.");
  }
  if (!docxText.length) throw new Error('La fiche de cours ne contient aucun texte exploitable.');

  const startedAt = Date.now();
  const validIds = new Set(docxText.map((b) => b.stableId));
  const blockText = new Map(docxText.map((b) => [b.stableId, b.text]));
  const estimatedTotalMs =
    (metadata?.audioSizeBytes || 0) > 50 * 1024 * 1024 ? 6 * 60 * 1000 : 2 * 60 * 1000;

  const progress = (
    percent: number,
    stage: JobProgress['stage'],
    stageLabel: string,
    message: string
  ) => {
    const elapsedMs = Date.now() - startedAt;
    const remainingSeconds = Math.max(0, Math.ceil((estimatedTotalMs - elapsedMs) / 1000));
    onProgress({
      percent: Math.max(0, Math.min(99, Math.round(percent))),
      stage,
      stageLabel,
      message,
      stepDescription: message,
      estimatedRemainingSeconds: remainingSeconds,
      etaFormatted: remainingSeconds > 0 ? formatEta(remainingSeconds) : 'quelques instants',
      startedAt,
      elapsedSeconds: Math.floor(elapsedMs / 1000),
    });
  };

  const execution = async (): Promise<Suggestion[]> => {
    progress(
      20,
      'doc_prep',
      'Préparation de la fiche',
      'Vérification du fichier audio et indexation de la fiche...'
    );

    const waitStarted = Date.now();
    let file = await ai.files.get({ name: geminiFileName });
    while (file.state === 'PROCESSING') {
      if (Date.now() - waitStarted > FILE_READY_TIMEOUT_MS) {
        throw new Error("Gemini met trop de temps à préparer l'audio. Veuillez réessayer.");
      }
      const fraction = Math.min(1, (Date.now() - waitStarted) / FILE_READY_TIMEOUT_MS);
      progress(
        20 + Math.round(fraction * 7),
        'doc_prep',
        'Préparation de la fiche',
        'Finalisation du fichier audio sur Gemini...'
      );
      await sleep(2000);
      file = await ai.files.get({ name: geminiFileName });
    }
    if (file.state === 'FAILED') {
      throw new Error("Gemini n'a pas pu préparer le fichier audio. Veuillez le renvoyer.");
    }
    if (file.state !== 'ACTIVE') {
      throw new Error(`État inattendu du fichier audio : ${String(file.state || 'inconnu')}.`);
    }

    const context = JSON.stringify(docxText);
    progress(
      30,
      'course_analysis',
      'Analyse du cours',
      'Comparaison du cours audio avec la fiche N-1...'
    );

    const flashStarted = Date.now();
    let flashDone = false;
    const flashTicker = setInterval(() => {
      if (flashDone) return;
      const fraction = Math.min(
        0.98,
        (Date.now() - flashStarted) / Math.max(45_000, estimatedTotalMs * 0.78)
      );
      progress(
        30 + Math.floor(49 * Math.pow(fraction, 0.85)),
        'course_analysis',
        'Analyse du cours',
        'Comparaison de l’enregistrement avec la fiche N-1...'
      );
    }, 2000);

    const flashPrompt = `Tu mets à jour une fiche de prépa médicale à partir du cours audio de cette année.

ÉTAPE 0 OBLIGATOIRE — CORRESPONDANCE : vérifie d'abord que l'audio traite réellement du même cours que la fiche. Si l'audio est hors sujet, un test, une conversation quelconque ou un autre cours : sameCourse=false et toutes les listes doivent être vides.

RÈGLES :
- La fiche N-1 est le document maître. Ne la réécris pas.
- Pas de transcription intégrale, pas de résumé global.
- Ignore anecdotes, répétitions, logistique, hésitations et simples reformulations.
- ADD : notion réellement nouvelle et utile.
- DELETE : seulement si le professeur dit explicitement qu'une notion est retirée, fausse, obsolète ou hors programme. Une notion non répétée ne doit jamais être supprimée.
- MODIFICATION : changement réel de valeur, définition ou fond ; retourne le paragraphe complet actualisé.
- Les notions étoilées/TD/annales restent si aucun retrait explicite n'est entendu.
- Chaque candidat doit viser un stableId existant et contenir un horodatage audio.
- En cas de doute, uncertainPassages.

Réponds UNIQUEMENT en JSON valide :
{
  "courseMatch":{"sameCourse":true,"confidence":95,"reason":"...","matchedTopics":["..."]},
  "candidateAdditions":[{"targetBlock":"p-12","proposedText":"...","reason":"...","audioEvidence":"01:23:45","confidence":90}],
  "candidateDeletions":[{"targetBlock":"p-15","originalText":"paragraphe complet","reason":"retrait explicite","audioEvidence":"01:40:10","confidence":90}],
  "candidateModifications":[{"targetBlock":"p-20","originalText":"paragraphe complet","proposedText":"paragraphe complet actualisé","reason":"...","audioEvidence":"02:10:30","confidence":90}],
  "uncertainPassages":[{"targetBlock":"p-25","passageText":"...","questionOrIssue":"...","audioEvidence":"02:25:00","confidence":55}]
}

FICHE N-1 STRUCTURÉE :
${context}`;

    let flash: FlashResult;
    try {
      const response: any = await withTimeout(
        ai.models.generateContent({
          model: FLASH_MODEL,
          contents: [
            { fileData: { fileUri: geminiFileUri, mimeType: geminiMimeType } },
            flashPrompt,
          ],
          config: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
        FLASH_TIMEOUT_MS,
        "L'analyse audio a dépassé le délai prévu. Veuillez réessayer."
      );
      flash = parseJsonObject<FlashResult>(response.text || '{}');
    } finally {
      flashDone = true;
      clearInterval(flashTicker);
    }

    const matchConfidence = confidence(flash.courseMatch?.confidence, 0);
    if (flash.courseMatch?.sameCourse === false || matchConfidence < 55) {
      const reason = flash.courseMatch?.reason?.trim();
      throw new Error(
        reason
          ? `L’audio ne semble pas correspondre à cette fiche (${reason}). Vérifiez les fichiers puis réessayez.`
          : 'L’audio ne semble pas correspondre à cette fiche de cours. Vérifiez les fichiers puis réessayez.'
      );
    }

    const valid = (items?: Candidate[]) =>
      (Array.isArray(items) ? items : []).filter(
        (item) => item.targetBlock && validIds.has(item.targetBlock)
      );
    const deltas = {
      candidateAdditions: valid(flash.candidateAdditions),
      candidateDeletions: valid(flash.candidateDeletions),
      candidateModifications: valid(flash.candidateModifications),
      uncertainPassages: valid(flash.uncertainPassages),
    };
    const count = Object.values(deltas).reduce((sum, list) => sum + list.length, 0);
    if (!count) return [];

    progress(
      80,
      'verification',
      'Vérification des actualisations',
      'Filtrage des différences détectées avec Gemini Pro...'
    );

    const proPrompt = `Tu es le réviseur final de Co-Ordo. Tu ne reçois PAS l'audio. Tu reçois la fiche N-1 et des deltas déjà extraits avec leurs preuves temporelles.

RÈGLES :
- REJECT : reformulation, anecdote, ajout sans intérêt, preuve insuffisante ou contradiction.
- ADD : vraie notion nouvelle.
- DELETE : uniquement retrait/obsolescence explicite.
- REPLACE : vraie modification de fond ; proposedText doit être le paragraphe complet actualisé.
- VERIFY : doute raisonnable nécessitant l'étudiant.
- targetBlock doit exister dans la fiche N-1.
- N'invente rien qui ne soit déjà dans les deltas.

Réponds UNIQUEMENT en JSON valide :
{"suggestions":[{"type":"ADD|DELETE|REPLACE|VERIFY|REJECT","targetBlock":"p-12","proposedText":"...","originalText":"...","reason":"...","confidence":90,"audioEvidence":"01:23:45"}]}

FICHE N-1 :
${context}

DELTAS :
${JSON.stringify(deltas)}`;

    let items: ProItem[];
    try {
      const response: any = await withTimeout(
        ai.models.generateContent({
          model: PRO_MODEL,
          contents: proPrompt,
          config: { responseMimeType: 'application/json', temperature: 0.05 },
        }),
        PRO_TIMEOUT_MS,
        'La vérification finale a dépassé le délai prévu.'
      );
      const parsed = parseJsonObject<{ suggestions?: ProItem[] }>(response.text || '{}');
      items = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    } catch (error) {
      console.error('[Gemini Pro verification error]', error);
      const fallback: Candidate[] = [
        ...deltas.candidateAdditions,
        ...deltas.candidateDeletions,
        ...deltas.candidateModifications,
        ...deltas.uncertainPassages,
      ];
      return fallback.map((item) => ({
        id: uuidv4(),
        type: 'VERIFY',
        targetBlock: item.targetBlock,
        proposedText: item.proposedText || item.passageText,
        originalText:
          item.originalText || (item.targetBlock ? blockText.get(item.targetBlock) : undefined),
        reason:
          item.reason ||
          item.questionOrIssue ||
          'Vérification manuelle requise : le second contrôle IA a échoué.',
        confidence: confidence(item.confidence, 50),
        audioEvidence: evidence(item.audioEvidence),
        status: 'pending',
      }));
    }

    const suggestions: Suggestion[] = [];
    for (const item of items) {
      if (
        !item.type ||
        item.type === 'REJECT' ||
        !item.targetBlock ||
        !validIds.has(item.targetBlock)
      ) {
        continue;
      }
      const original = item.originalText?.trim() || blockText.get(item.targetBlock) || '';
      const proposed = item.proposedText?.trim();
      if (item.type === 'ADD' && !proposed) continue;
      if (item.type === 'REPLACE' && !proposed) continue;
      suggestions.push({
        id: uuidv4(),
        type: item.type,
        targetBlock: item.targetBlock,
        proposedText: proposed,
        originalText: original,
        reason: item.reason?.trim() || 'Différence détectée dans le cours de cette année.',
        confidence: confidence(item.confidence),
        audioEvidence: evidence(item.audioEvidence),
        status: 'pending',
      });
    }

    progress(
      95,
      'finalizing',
      'Préparation de la fiche',
      'Préparation des propositions à valider...'
    );
    return suggestions;
  };

  return withTimeout(
    execution(),
    TOTAL_TIMEOUT_MS,
    'L’analyse a pris trop de temps. Veuillez réessayer.'
  );
}
