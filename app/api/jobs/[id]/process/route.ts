import { NextRequest, NextResponse } from 'next/server';
import { getJob, saveJob } from '@/lib/db';
import { parseDocx, extractTextWithIds } from '@/lib/docx';
import { processCourseAudio } from '@/lib/gemini';
import fs from 'fs';

export const maxDuration = 1200;
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: 'Job non trouvé.' }, { status: 404 });

  if (job.status === 'review' || job.status === 'completed') {
    return NextResponse.json({ success: true, status: job.status });
  }

  if (!job.geminiFileName || !job.geminiFileUri || !job.geminiMimeType) {
    job.status = 'failed';
    job.error = "L’envoi audio n’a pas été finalisé. Veuillez renvoyer le fichier.";
    saveJob(job);
    return NextResponse.json({ error: job.error }, { status: 409 });
  }
  if (!job.originalDocxPath || !fs.existsSync(job.originalDocxPath)) {
    job.status = 'failed';
    job.error = 'La fiche préparée n’est plus disponible. Veuillez recommencer.';
    saveJob(job);
    return NextResponse.json({ error: job.error }, { status: 410 });
  }

  job.status = 'processing';
  job.error = undefined;
  job.progress = {
    percent: 20,
    stage: 'doc_prep',
    stageLabel: 'Préparation de la fiche',
    message: 'Fichiers reçus, préparation de la comparaison...',
    stepDescription: 'Extraction des paragraphes et métadonnées...',
    etaFormatted: job.progress?.etaFormatted || 'Temps restant estimé : quelques minutes',
    startedAt: Date.now(),
    elapsedSeconds: 0,
  };
  saveJob(job);

  try {
    const docxBuffer = fs.readFileSync(job.originalDocxPath);
    const { doc } = parseDocx(docxBuffer);
    const blocks = extractTextWithIds(doc);
    const mappedBlocks = blocks.map((block) => ({ stableId: block.stableId, text: block.text }));
    if (!mappedBlocks.length) throw new Error('La fiche ne contient aucun texte exploitable.');

    const suggestions = await processCourseAudio(
      job.geminiFileName,
      job.geminiFileUri,
      job.geminiMimeType,
      mappedBlocks,
      (progressUpdate) => {
        job.progress = { ...job.progress, ...progressUpdate };
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

    job.suggestions = suggestions;
    job.progress = {
      percent: 100,
      stage: 'completed',
      stageLabel: 'Actualisation terminée',
      message: suggestions.length
        ? 'Actualisation terminée : vérifiez les propositions.'
        : 'Aucune modification fiable n’a été détectée.',
      stepDescription: 'Actualisation terminée',
      etaFormatted: '0 s',
      estimatedRemainingSeconds: 0,
    };
    job.status = 'review';
    saveJob(job);

    return NextResponse.json({ success: true, status: 'review', suggestionsCount: suggestions.length });
  } catch (error: any) {
    console.error(`[Job ${job.id} error]`, error?.message || error);
    job.status = 'failed';
    job.error = error?.message || "L’analyse n’a pas pu être terminée. Réessayez.";
    job.progress = {
      ...job.progress,
      message: 'Échec de l’analyse',
      stepDescription: job.error,
    };
    saveJob(job);
    return NextResponse.json({ error: job.error }, { status: 500 });
  }
}
