import Pizzip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export function parseDocx(buffer: Buffer) {
  const zip = new Pizzip(buffer);
  const documentXml = zip.file('word/document.xml')?.asText();
  if (!documentXml) throw new Error('Invalid DOCX: missing word/document.xml');

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'text/xml');
  
  return { zip, doc };
}

export function extractTextWithIds(doc: any) {
  const paragraphs = doc.getElementsByTagName('w:p');
  const blocks: { stableId: string; text: string; node: any }[] = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    
    // Add a unique ID to the paragraph if it doesn't have one to make sure we can find it later
    // In OpenXML, we can use w14:paraId but let's just use a simple index mapped to the node
    let text = '';
    const runs = p.getElementsByTagName('w:t');
    for (let j = 0; j < runs.length; j++) {
      if (runs[j].textContent) {
         text += runs[j].textContent;
      }
    }
    if (text.trim()) {
      blocks.push({
        stableId: `p-${i}`,
        text: text.trim(),
        node: p,
      });
    }
  }
  return blocks;
}

export function applyPatches(doc: any, suggestions: any[], blocks: { stableId: string; text: string; node: any }[]) {
  // Sort suggestions by stableId descending so insertions don't mess up subsequent indices
  // Actually since we mapped nodes directly, we can just use the node reference!
  
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'accepted') continue;
    
    const targetBlock = blocks.find(b => b.stableId === suggestion.targetBlock);
    if (!targetBlock) continue;

    const p = targetBlock.node;

    if (suggestion.type === 'ADD') {
      // Clone the target paragraph
      const newP = p.cloneNode(true);
      // Change the text inside the new paragraph to the proposed text
      // We will clear all existing runs and add a new run with the new text and cyan highlight
      
      const runs = newP.getElementsByTagName('w:r');
      // Keep only the first run to preserve basic properties, remove others
      for (let i = runs.length - 1; i > 0; i--) {
        newP.removeChild(runs[i]);
      }
      
      const firstRun = newP.getElementsByTagName('w:r')[0];
      if (firstRun) {
        // Update text
        const t = firstRun.getElementsByTagName('w:t')[0];
        if (t) {
          t.textContent = suggestion.proposedText;
          // Set xml:space="preserve"
          t.setAttribute('xml:space', 'preserve');
        }

        // Add highlight and bold
        let rPr = firstRun.getElementsByTagName('w:rPr')[0];
        if (!rPr) {
          rPr = doc.createElement('w:rPr');
          firstRun.insertBefore(rPr, firstRun.firstChild);
        }

        // Highlight
        let highlight = rPr.getElementsByTagName('w:highlight')[0];
        if (!highlight) {
          highlight = doc.createElement('w:highlight');
          rPr.appendChild(highlight);
        }
        highlight.setAttribute('w:val', 'cyan');

        // Bold
        let b = rPr.getElementsByTagName('w:b')[0];
        if (!b) {
          b = doc.createElement('w:b');
          rPr.appendChild(b);
        }
      }
      
      // Insert after the target block
      if (p.nextSibling) {
        p.parentNode.insertBefore(newP, p.nextSibling);
      } else {
        p.parentNode.appendChild(newP);
      }
    } 
    else if (suggestion.type === 'DELETE') {
      // For delete, we strike-through and highlight the existing paragraph runs
      const runs = p.getElementsByTagName('w:r');
      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        let rPr = run.getElementsByTagName('w:rPr')[0];
        if (!rPr) {
          rPr = doc.createElement('w:rPr');
          run.insertBefore(rPr, run.firstChild);
        }

        // Strike
        let strike = rPr.getElementsByTagName('w:strike')[0];
        if (!strike) {
          strike = doc.createElement('w:strike');
          rPr.appendChild(strike);
        }
        strike.setAttribute('w:val', 'true'); // some versions just need the element

        // Highlight
        let highlight = rPr.getElementsByTagName('w:highlight')[0];
        if (!highlight) {
          highlight = doc.createElement('w:highlight');
          rPr.appendChild(highlight);
        }
        highlight.setAttribute('w:val', 'cyan');
      }
    }
  }
}

export function serializeDocx(zip: Pizzip, doc: any) {
  const serializer = new XMLSerializer();
  const xmlString = serializer.serializeToString(doc);
  zip.file('word/document.xml', xmlString);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
