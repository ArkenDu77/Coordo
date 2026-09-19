import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const DATA_DIR = path.join(process.cwd(), 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
[DATA_DIR, JOBS_DIR, UPLOADS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

export type JobStatus = 'pending' | 'uploading' | 'processing' | 'review' | 'completed' | 'failed';

export interface DocumentBlock {
  stableId: string;
  text: string;
  location: string;
  style: any;
}

export type JobStage = 
  | 'upload'
  | 'doc_prep'
  | 'course_analysis'
  | 'verification'
  | 'finalizing'
  | 'completed'
  // Backward-compatibility aliases
  | 'audio_prep'
  | 'doc_analysis'
  | 'gemini_analysis';

export interface JobProgress {
  message: string;
  percent: number;
  stage?: JobStage;
  stageLabel?: string;
  stepDescription?: string;
  estimatedRemainingSeconds?: number | null;
  etaFormatted?: string;
  startedAt?: number;
  elapsedSeconds?: number;
}

export interface Suggestion {
  id: string;
  type: 'ADD' | 'DELETE' | 'VERIFY';
  targetBlock?: string;
  proposedText?: string;
  originalText?: string;
  reason: string;
  confidence: number;
  audioEvidence: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface CourseUpdateJob {
  id: string;
  createdAt: string;
  status: JobStatus;
  subject: string;
  courseName: string;
  originalDocxPath: string;
  audioPath: string;
  audioDuration?: number;
  audioSizeBytes?: number;
  documentSizeBytes?: number;
  progress: JobProgress;
  suggestions: Suggestion[];
  error?: string;
  sourceDocumentName?: string;
  sourceDocumentPath?: string;
  sourceFormat?: string;
  conversionWarning?: string;
  geminiUploadUrl?: string;
  geminiFileName?: string;
  geminiFileUri?: string;
  geminiMimeType?: string;
  updatedAt?: number;
}

export function createJob(subject: string, courseName: string, originalDocxPath: string, audioPath: string): CourseUpdateJob {
  const job: CourseUpdateJob = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
    status: 'pending',
    subject,
    courseName,
    originalDocxPath,
    audioPath,
    progress: { message: 'Initialisation', percent: 0 },
    suggestions: [],
  };
  saveJob(job);
  return job;
}

export function getJob(id: string): CourseUpdateJob | null {
  const jobPath = path.join(JOBS_DIR, `${id}.json`);
  if (!fs.existsSync(jobPath)) return null;
  return JSON.parse(fs.readFileSync(jobPath, 'utf8'));
}

export function saveJob(job: CourseUpdateJob) {
  job.updatedAt = Date.now();
  const jobPath = path.join(JOBS_DIR, `${job.id}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
}

export function getAllJobs(): CourseUpdateJob[] {
  const files = fs.readdirSync(JOBS_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getUploadPath(filename: string) {
  return path.join(UPLOADS_DIR, `${uuidv4()}-${filename}`);
}
