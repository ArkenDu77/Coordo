import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob } from '@/lib/db';
import { parseDocx, extractTextWithIds } from '@/lib/docx';
import { processCourseAudio } from '@/lib/gemini';
import fs from 'fs';

export const maxDuration = 1200; // 20 minutes maximum
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: 'Job non trouvé' }, { status: 404 });
  }

  // Si le job est déjà terminé avec succès, renvoyer immédiatement
  if (job.status === 'review' || job.status === 'completed') {
    return NextResponse.json({ success: true, status: job.status });
  }

  // Initialisation du statut de traitement
  job.status = 'processing';
  job.progress = {
    percent: 20,
    stage: 'doc_prep',
    stageLabel: 'Préparation de la fiche',
    message: 'Fichiers reçus, préparation de la fiche et de l’audio...',
    stepDescription: 'Extraction des paragraphes et métadonnées...',
    etaFormatted: job.progress?.etaFormatted || 'Temps restant estimé : quelques minutes',
    startedAt: Date.now(),
    elapsedSeconds: 0,
  };
  saveJob(job);

  try {
    // 1. Extraction et indexation du DOCX
    const docxBuffer = fs.readFileSync(job.originalDocxPath);
    const { doc } = parseDocx(docxBuffer);
    const blocks = extractTextWithIds(doc);
    const mappedBlocks = blocks.map(b => ({ stableId: b.stableId, text: b.text }));

    // 2. Traitement direct et synchrone de l'audio : la requête HTTP attend VRAIMENT la fin
    console.log(`[Job ${job.id}] Démarrage synchrone de l'analyse audio...`);
    const suggestions = await processCourseAudio(
      job.geminiFileName!,
      job.geminiFileUri!,
      job.geminiMimeType!,
      mappedBlocks,
      (progressUpdate) => {
        job.progress = {
          ...job.progress,
          ...progressUpdate,
        };
        saveJob(job);
      },
      {
        jobId: job.id,
        audioSizeBytes: job.audioSizeBytes,
        audioDurationSeconds: job.audioDuration,
        documentSizeBytes: job.documentSizeBytes,
        documentType: job.sourceFormat || 'docx',
      }
    );

    // 3. Enregistrement des suggestions et passage en mode révision
    job.suggestions = suggestions;
    job.progress = {
      percent: 100,
      stage: 'completed',
      stageLabel: 'Actualisation terminée',
      message: '100 % — Actualisation terminée',
      stepDescription: 'Actualisation terminée',
      etaFormatted: '0 s',
      estimatedRemainingSeconds: 0,
    };
    job.status = 'review';
    saveJob(job);

    console.log(`[Job ${job.id}] Analyse terminée avec succès : ${suggestions.length} suggestions générées.`);
    return NextResponse.json({
      success: true,
      status: 'review',
      suggestionsCount: suggestions.length,
    });
  } catch (err: any) {
    console.error(`[Job ${job.id} Error]`, {
      message: err?.message,
      stack: err?.stack,
    });

    job.status = 'failed';
    const isTimeout = err?.message?.includes('trop de temps') || err?.name === 'AbortError';
    job.error = isTimeout 
      ? "L’analyse a pris trop de temps. Veuillez réessayer."
      : (err?.message || "L’analyse n’a pas pu être terminée. Réessayez dans quelques instants.");

    job.progress = {
      ...job.progress,
      message: "Échec de l'analyse",
      stepDescription: job.error,
    };
    saveJob(job);

    return NextResponse.json({ error: job.error }, { status: 500 });
  }
}
