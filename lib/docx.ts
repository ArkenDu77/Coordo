import Pizzip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Suggestion } from '@/lib/db';

export function parseDocx(buffer: Buffer) {
  const zip = new Pizzip(buffer);
  const documentXml = zip.file('word/document.xml')?.asText();
  if (!documentXml) throw new Error('DOCX invalide : word/document.xml est absent.');

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'text/xml');
  return { zip, doc };
}

export function extractTextWithIds(doc: any) {
  const paragraphs = doc.getElementsByTagName('w:p');
  const blocks: { stableId: string; text: string; node: any }[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    let text = '';
    const runs = paragraph.getElementsByTagName('w:t');
    for (let j = 0; j < runs.length; j++) {
      if (runs[j].textContent) text += runs[j].textContent;
    }
    if (text.trim()) {
      blocks.push({ stableId: `p-${i}`, text: text.trim(), node: paragraph });
    }
  }
  return blocks;
}

function getOrCreateRunProperties(doc: any, run: any) {
  let rPr = run.getElementsByTagName('w:rPr')[0];
  if (!rPr) {
    rPr = doc.createElement('w:rPr');
    run.insertBefore(rPr, run.firstChild);
  }
  return rPr;
}

function setOnOffProperty(doc: any, parent: any, tagName: string, value = 'true') {
  let node = parent.getElementsByTagName(tagName)[0];
  if (!node) {
    node = doc.createElement(tagName);
    parent.appendChild(node);
  }
  node.setAttribute('w:val', value);
}

function setHighlight(doc: any, rPr: any, value = 'cyan') {
  let highlight = rPr.getElementsByTagName('w:highlight')[0];
  if (!highlight) {
    highlight = doc.createElement('w:highlight');
    rPr.appendChild(highlight);
  }
  highlight.setAttribute('w:val', value);
}

function markParagraphDeleted(doc: any, paragraph: any) {
  const runs = paragraph.getElementsByTagName('w:r');
  for (let i = 0; i < runs.length; i++) {
    const rPr = getOrCreateRunProperties(doc, runs[i]);
    setOnOffProperty(doc, rPr, 'w:strike');
    setHighlight(doc, rPr, 'cyan');
  }
}

function createInsertedParagraph(doc: any, sourceParagraph: any, text: string) {
  const newParagraph = doc.createElement('w:p');

  const sourcePPr = sourceParagraph.getElementsByTagName('w:pPr')[0];
  if (sourcePPr) newParagraph.appendChild(sourcePPr.cloneNode(true));

  const newRun = doc.createElement('w:r');
  const sourceRun = sourceParagraph.getElementsByTagName('w:r')[0];
  const sourceRPr = sourceRun?.getElementsByTagName('w:rPr')[0];
  const newRPr = sourceRPr ? sourceRPr.cloneNode(true) : doc.createElement('w:rPr');

  setOnOffProperty(doc, newRPr, 'w:b');
  setHighlight(doc, newRPr, 'cyan');
  newRun.appendChild(newRPr);

  const textNode = doc.createElement('w:t');
  textNode.setAttribute('xml:space', 'preserve');
  textNode.appendChild(doc.createTextNode(text));
  newRun.appendChild(textNode);
  newParagraph.appendChild(newRun);

  return newParagraph;
}

function insertAfter(referenceNode: any, newNode: any) {
  const parent = referenceNode.parentNode;
  if (!parent) return;
  if (referenceNode.nextSibling) parent.insertBefore(newNode, referenceNode.nextSibling);
  else parent.appendChild(newNode);
}

export function applyPatches(
  doc: any,
  suggestions: Suggestion[],
  blocks: { stableId: string; text: string; node: any }[]
) {
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'accepted') continue;
    const targetBlock = blocks.find((block) => block.stableId === suggestion.targetBlock);
    if (!targetBlock) continue;

    const paragraph = targetBlock.node;
    const proposedText = suggestion.proposedText?.trim();

    if (suggestion.type === 'ADD') {
      if (!proposedText) continue;
      insertAfter(paragraph, createInsertedParagraph(doc, paragraph, proposedText));
      continue;
    }

    if (suggestion.type === 'DELETE') {
      markParagraphDeleted(doc, paragraph);
      continue;
    }

    if (suggestion.type === 'REPLACE') {
      if (!proposedText) continue;
      markParagraphDeleted(doc, paragraph);
      insertAfter(paragraph, createInsertedParagraph(doc, paragraph, proposedText));
      continue;
    }

    if (suggestion.type === 'VERIFY' && proposedText) {
      // Si l'utilisateur accepte explicitement un point à vérifier, on l'insère sans
      // supprimer le texte existant. Cela évite toute destruction ambiguë de la fiche.
      insertAfter(paragraph, createInsertedParagraph(doc, paragraph, proposedText));
    }
  }
}

export function serializeDocx(zip: Pizzip, doc: any) {
  const serializer = new XMLSerializer();
  zip.file('word/document.xml', serializer.serializeToString(doc));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
