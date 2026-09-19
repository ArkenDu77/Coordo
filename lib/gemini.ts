import { GoogleGenAI } from '@google/genai';
import { v4 as uuidv4 } from 'uuid';
import { JobProgress, Suggestion } from '@/lib/db';
import { getEstimatedDurationMs, formatETA, recordAnalysisRun } from '@/lib/analytics';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const FLASH_MODEL = 'gemini-3.8-flash';
const PRO_MODEL = 'gemini-3.1-pro-preview';
const TOTAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

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
  const startTime = Date.now();
  const audioSize = metadata?.audioSizeBytes || 0;
  const docSize = metadata?.documentSizeBytes || 0;
  const docType = metadata?.documentType || 'docx';

  // Estimation du temps global basée sur l'historique ou taille
  const etaCalc = getEstimatedDurationMs({
    audioSizeBytes: audioSize,
    audioDurationSeconds: metadata?.audioDurationSeconds,
    documentSizeBytes: docSize,
    documentType: docType,
    model: FLASH_MODEL,
  });

  // Pour 3–4 h d'audio avec Flash + Pro texte, durée cible entre 3 et 8 min
  const estimatedTotalMs = etaCalc?.estimatedTotalMs ?? (audioSize > 50 * 1024 * 1024 ? 300000 : 120000);

  function updateProgress(
    percent: number,
    stage: JobProgress['stage'],
    stageLabel: string,
    message: string
  ) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    let remainingSeconds: number | null = null;

    if (estimatedTotalMs) {
      const remainingMs = Math.max(3000, estimatedTotalMs - (Date.now() - startTime));
      remainingSeconds = Math.ceil(remainingMs / 1000);
    }

    onProgress({
      percent: Math.min(99, Math.max(0, Math.round(percent))),
      stage,
      stageLabel,
      message,
      stepDescription: message,
      estimatedRemainingSeconds: remainingSeconds,
      etaFormatted: formatETA(remainingSeconds),
      startedAt: startTime,
      elapsedSeconds,
    });
  }

  // Timer de sécurité global de 20 minutes
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error("L’analyse a pris trop de temps. Veuillez réessayer."));
    }, TOTAL_TIMEOUT_MS);
  });

  const executionPromise = (async (): Promise<Suggestion[]> => {
    // -------------------------------------------------------------
    // ÉTAPE 2 : 20–30 % — Préparation de la fiche & Vérification audio
    // -------------------------------------------------------------
    updateProgress(20, 'doc_prep', 'Préparation de la fiche', 'Vérification de l’audio et indexation de la fiche...');

    let fileInfo = await ai.files.get({ name: geminiFileName });
    let prepAttempts = 0;
    while (fileInfo.state === 'PROCESSING' && prepAttempts < 30) {
      prepAttempts++;
      const currentPct = 20 + Math.min(6, Math.round((prepAttempts / 15) * 5));
      updateProgress(currentPct, 'doc_prep', 'Préparation de la fiche', 'Finalisation du fichier audio sur Gemini...');
      await new Promise(r => setTimeout(r, 2000));
      fileInfo = await ai.files.get({ name: geminiFileName });
    }

    if (fileInfo.state === 'FAILED') {
      console.error('[Gemini File Error] File state is FAILED:', fileInfo);
      throw new Error("L'analyse n’a pas pu être terminée. Réessayez dans quelques instants.");
    }

    updateProgress(28, 'doc_prep', 'Préparation de la fiche', 'Fiche indexée, préparation de l’analyse...');
    const docxContext = JSON.stringify(docxText);

    // -------------------------------------------------------------
    // ÉTAPE 3 : 30–80 % — Analyse du cours (gemini-3.8-flash sur l'audio)
    // -------------------------------------------------------------
    updateProgress(30, 'course_analysis', 'Analyse du cours', 'Écoute et comparaison du cours audio avec la fiche...');

    const flashStartTime = Date.now();
    let flashCompleted = false;

    // Progression estimée fluide entre 30% et 79% pendant l'analyse Flash
    const flashProgressInterval = setInterval(() => {
      if (flashCompleted) return;
      const elapsedFlash = Date.now() - flashStartTime;
      const expectedFlashMs = Math.max(30000, estimatedTotalMs * 0.75);
      const fraction = Math.min(1, elapsedFlash / expectedFlashMs);
      const simulatedPct = 30 + Math.floor(49 * Math.min(0.98, Math.pow(fraction, 0.85)));

      updateProgress(
        Math.min(79, simulatedPct),
        'course_analysis',
        'Analyse du cours',
        'Comparaison de l’enregistrement audio avec la fiche N-1 en cours...'
      );
    }, 2000);

    const flashPrompt = `Tu es un assistant expert pour une prépa médicale (Co-Ordo).
Ta mission est d'écouter l'enregistrement audio complet du cours de cette année et de le comparer méticuleusement avec la fiche de cours N-1 (fournie ci-dessous sous forme de paragraphes JSON avec leur stableId et leur texte).

RÈGLES IMPORTANTES :
1. LE DOCUMENT N-1 EST LE DOCUMENT MAÎTRE. Sois conservateur.
2. NE FAIS PAS de transcription intégrale des 3–4 heures de cours.
3. NE FAIS PAS de résumé global du cours.
4. NE RÉÉCRIS PAS la fiche en entier.
5. Ta seule mission est d'identifier les DELTAS (différences potentielles) entre le cours oral et la fiche N-1 :
   - Notions nouvelles, chiffres actualisés, précisions ajoutées par le professeur cette année.
   - Notions explicitement supprimées ou signalées comme hors programme cette année.
   - Reformulations importantes ou incertitudes méritant vérification.
   - Ignore les blagues, digressions, logistique, hésitations orales et simples synonymes stylistiques.

Format de sortie attendu : Renvoie UNIQUEMENT un objet JSON compact respectant cette structure exacte :
{
  "candidateAdditions": [
    {
      "targetBlock": "le stableId du paragraphe N-1 qui précède logiquement l'ajout",
      "proposedText": "Texte exact de l'information à ajouter",
      "reason": "Explication pédagogique concise",
      "audioEvidence": "Horodatage précis (ex: 01:23:45 ou 42:15)",
      "confidence": 85
    }
  ],
  "candidateDeletions": [
    {
      "targetBlock": "le stableId du paragraphe N-1 concerné",
      "originalText": "Extrait du texte de la fiche N-1 à supprimer",
      "reason": "Pourquoi cette notion ne doit plus figurer",
      "audioEvidence": "Horodatage ou mention orale",
      "confidence": 80
    }
  ],
  "candidateModifications": [
    {
      "targetBlock": "le stableId du paragraphe N-1 concerné",
      "originalText": "Texte original",
      "proposedText": "Texte actualisé",
      "reason": "Justification du changement de valeur/définition",
      "audioEvidence": "Horodatage précis",
      "confidence": 90
    }
  ],
  "uncertainPassages": [
    {
      "targetBlock": "le stableId du paragraphe concerné",
      "passageText": "Passage concerné",
      "questionOrIssue": "Point à faire arbitrer par l'étudiant",
      "audioEvidence": "Horodatage précis",
      "confidence": 60
    }
  ]
}

FICHE N-1 :
${docxContext}`;

    let flashRawText = '';
    try {
      console.log(`[Flash Analysis Start] Sending audio ${geminiFileName} to ${FLASH_MODEL}...`);
      const flashResponse = await ai.models.generateContent({
        model: FLASH_MODEL,
        contents: [
          {
            fileData: {
              fileUri: geminiFileUri,
              mimeType: geminiMimeType,
            },
          },
          flashPrompt,
        ],
      });
      flashRawText = flashResponse.text || '';
      console.log(`[Flash Analysis Complete] Received ${flashRawText.length} chars from ${FLASH_MODEL}`);
    } catch (flashErr: any) {
      console.error(`[Flash Analysis Error]`, flashErr);
      throw new Error("L’analyse n’a pas pu être terminée. Réessayez dans quelques instants.");
    } finally {
      clearInterval(flashProgressInterval);
      flashCompleted = true;
    }

    // Extraction du JSON compact produit par Flash
    let flashDeltas: any = {
      candidateAdditions: [],
      candidateDeletions: [],
      candidateModifications: [],
      uncertainPassages: [],
    };

    try {
      const jsonMatch = flashRawText.match(/```json\s*([\s\S]*?)\s*```/) || flashRawText.match(/([\{\[][\s\S]*[\}\]])/);
      const textToParse = jsonMatch ? jsonMatch[1] : flashRawText;
      const parsed = JSON.parse(textToParse.trim());
      flashDeltas = {
        candidateAdditions: Array.isArray(parsed.candidateAdditions) ? parsed.candidateAdditions : [],
        candidateDeletions: Array.isArray(parsed.candidateDeletions) ? parsed.candidateDeletions : [],
        candidateModifications: Array.isArray(parsed.candidateModifications) ? parsed.candidateModifications : [],
        uncertainPassages: Array.isArray(parsed.uncertainPassages) ? parsed.uncertainPassages : [],
      };
    } catch (parseErr) {
      console.warn('[Flash Delta Parsing Warning]', parseErr, 'Raw snippet:', flashRawText.slice(0, 300));
    }

    const totalCandidatesCount = 
      flashDeltas.candidateAdditions.length +
      flashDeltas.candidateDeletions.length +
      flashDeltas.candidateModifications.length +
      flashDeltas.uncertainPassages.length;

    console.log(`[Flash Deltas Extracted] Total candidate deltas: ${totalCandidatesCount}`);

    // -------------------------------------------------------------
    // ÉTAPE 4 : 80–95 % — Vérification des actualisations (gemini-3.1-pro-preview SANS AUDIO)
    // -------------------------------------------------------------
    updateProgress(80, 'verification', 'Vérification des actualisations', 'Vérification approfondie et filtrage avec Gemini Pro...');

    const proStartTime = Date.now();
    let proCompleted = false;

    const proProgressInterval = setInterval(() => {
      if (proCompleted) return;
      const elapsedPro = Date.now() - proStartTime;
      const simulatedPct = 80 + Math.min(14, Math.floor(elapsedPro / 2500));
      updateProgress(
        simulatedPct,
        'verification',
        'Vérification des actualisations',
        'Élimination des faux positifs et contrôle de cohérence...'
      );
    }, 1500);

    const proPrompt = `Tu es un réviseur expert de haut niveau pour des fiches de prépa médicale (Co-Ordo).
Une première analyse par IA a identifié des différences candidates potentielles entre le cours de cette année et la fiche N-1 de l'année précédente.
Ta mission est d'examiner ces propositions de manière critique, rigoureuse et conservatrice, sans AUCUNE hallucination.

RÈGLES PÉDAGOGIQUES STRICTES :
1. LE DOCUMENT N-1 EST LE MAÎTRE :
   - Supprime tous les faux positifs.
   - Ignore les simples reformulations stylistiques (si le fond n'a pas changé, NE PAS TOUCHER).
   - Sois extrêmement conservateur sur les suppressions : si une notion n'a pas été explicitement démentie ou retirée du programme, conserve-la ou marque 'VERIFY'.
2. CATÉGORISATION PRÉCISE :
   - 'ADD' : véritable nouvelle notion, nouvelle valeur chiffrée, nouveau médicament, précision utile absente de la fiche N-1.
   - 'DELETE' : notion expressément rendue obsolète ou retirée cette année.
   - 'VERIFY' : divergence subtile, doute ou formulation ambiguë nécessitant l'arbitrage de l'étudiant.
3. RÉSULTAT ATTENDU :
   Renvoie UNIQUEMENT un objet JSON avec une liste "suggestions" au format exact suivant :
{
  "suggestions": [
    {
      "type": "ADD" | "DELETE" | "VERIFY",
      "targetBlock": "le stableId du paragraphe concerné dans la fiche",
      "proposedText": "Texte à ajouter ou modifier (pour ADD ou VERIFY)",
      "originalText": "Texte original (pour DELETE ou VERIFY)",
      "reason": "Justification pédagogique claire et précise",
      "confidence": 85,
      "audioEvidence": "Horodatage hérité ou identifié (ex: 01:23:45)"
    }
  ]
}

FICHE N-1 STRUCTURÉE :
${docxContext}

DIFFÉRENCES CANDIDATES IDENTIFIÉES :
${JSON.stringify(flashDeltas, null, 2)}`;

    let proRawText = '';
    try {
      console.log(`[Pro Verification Start] Sending ${totalCandidatesCount} text candidates to ${PRO_MODEL} (WITHOUT audio)...`);
      // ATTENTION : Aucun fichier audio n'est transmis à Gemini Pro ! Uniquement du texte !
      const proResponse = await ai.models.generateContent({
        model: PRO_MODEL,
        contents: proPrompt,
      });
      proRawText = proResponse.text || '';
      console.log(`[Pro Verification Complete] Received ${proRawText.length} chars from ${PRO_MODEL}`);
    } catch (proErr: any) {
      console.error(`[Pro Verification Error]`, proErr);
      // Si Pro rencontre une erreur transitoire, repli propre sur les propositions Flash converties
      console.warn('[Fallback] Using Flash candidates directly due to Pro error');
    } finally {
      clearInterval(proProgressInterval);
      proCompleted = true;
    }

    // -------------------------------------------------------------
    // ÉTAPE 5 : 95–100 % — Préparation de la fiche (Finalisation)
    // -------------------------------------------------------------
    updateProgress(95, 'finalizing', 'Préparation de la fiche', 'Finalisation du rapport d’actualisation...');

    let finalSuggestions: Suggestion[] = [];

    // Tentative de parsing de la réponse Pro
    if (proRawText) {
      try {
        const jsonMatch = proRawText.match(/```json\s*([\s\S]*?)\s*```/) || proRawText.match(/([\{\[][\s\S]*[\}\]])/);
        const textToParse = jsonMatch ? jsonMatch[1] : proRawText;
        const parsed = JSON.parse(textToParse.trim());
        const rawList = parsed.suggestions || (Array.isArray(parsed) ? parsed : []);
        finalSuggestions = rawList.map((s: any) => ({
          id: s.id || uuidv4(),
          type: (s.type === 'DELETE' || s.type === 'VERIFY') ? s.type : 'ADD',
          targetBlock: s.targetBlock,
          proposedText: s.proposedText,
          originalText: s.originalText,
          reason: s.reason || 'Actualisation du cours',
          confidence: typeof s.confidence === 'number' ? Math.round(s.confidence) : 85,
          audioEvidence: s.audioEvidence || '',
          status: 'pending' as const,
        }));
      } catch (proParseErr) {
        console.warn('[Pro Parse Warning]', proParseErr, 'Snippet:', proRawText.slice(0, 300));
      }
    }

    // Si Pro n'a pas retourné de liste valide, convertir directement les deltas Flash
    if (finalSuggestions.length === 0 && totalCandidatesCount > 0) {
      const fallbackList: Suggestion[] = [];
      for (const a of flashDeltas.candidateAdditions) {
        fallbackList.push({
          id: uuidv4(),
          type: 'ADD',
          targetBlock: a.targetBlock,
          proposedText: a.proposedText,
          reason: a.reason || 'Ajout identifié dans l’audio',
          confidence: a.confidence || 80,
          audioEvidence: a.audioEvidence || '',
          status: 'pending',
        });
      }
      for (const m of flashDeltas.candidateModifications) {
        fallbackList.push({
          id: uuidv4(),
          type: 'ADD',
          targetBlock: m.targetBlock,
          proposedText: m.proposedText,
          originalText: m.originalText,
          reason: m.reason || 'Modification identifiée',
          confidence: m.confidence || 85,
          audioEvidence: m.audioEvidence || '',
          status: 'pending',
        });
      }
      for (const d of flashDeltas.candidateDeletions) {
        fallbackList.push({
          id: uuidv4(),
          type: 'DELETE',
          targetBlock: d.targetBlock,
          originalText: d.originalText,
          reason: d.reason || 'Notion non reprise ou obsolète',
          confidence: d.confidence || 75,
          audioEvidence: d.audioEvidence || '',
          status: 'pending',
        });
      }
      for (const u of flashDeltas.uncertainPassages) {
        fallbackList.push({
          id: uuidv4(),
          type: 'VERIFY',
          targetBlock: u.targetBlock,
          proposedText: u.passageText,
          reason: u.questionOrIssue || 'Passage à vérifier',
          confidence: u.confidence || 60,
          audioEvidence: u.audioEvidence || '',
          status: 'pending',
        });
      }
      finalSuggestions = fallbackList;
    }

    const totalDurationMs = Date.now() - startTime;

    // Enregistrement des analytics pour affiner l'ETA des prochaines analyses
    recordAnalysisRun({
      id: metadata?.jobId || uuidv4(),
      timestamp: Date.now(),
      audioSizeBytes: audioSize,
      audioDurationSeconds: metadata?.audioDurationSeconds,
      documentSizeBytes: docSize,
      documentType: docType,
      model: FLASH_MODEL,
      totalDurationMs,
      geminiDurationMs: totalDurationMs,
    });

    onProgress({
      percent: 100,
      stage: 'completed',
      stageLabel: 'Actualisation terminée',
      message: '100 % — Actualisation terminée',
      stepDescription: 'Actualisation terminée',
      estimatedRemainingSeconds: 0,
      etaFormatted: '0 s',
      startedAt: startTime,
      elapsedSeconds: Math.floor(totalDurationMs / 1000),
    });

    return finalSuggestions;
  })();

  // Course contre le timeout de 20 minutes
  return Promise.race([executionPromise, timeoutPromise]);
}
