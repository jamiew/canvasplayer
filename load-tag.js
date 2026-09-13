// Site-only data loading. Library modules do not depend on the DOM or this file.
// Public domain, Jamie Wilkinson & Free Art & Technology (F.A.T.) Lab.

const API = 'https://000000book.com/data/';
let pending = 0;

function drawingData(data, id) {
  if (!data || !data.gml) throw new Error('No drawing data for tag ' + id);
  return data.id ? data : { ...data, id };
}

// Accept a tag ID, "latest" or "random" and return the unparsed API envelope.
// JSONP is needed because the API has no CORS header.
export function loadTag(id) {
  return new Promise((resolve, reject) => {
    const name = '__gmlLoad' + (pending++);
    const script = document.createElement('script');
    const cleanup = () => { delete window[name]; script.remove(); };
    let answered = false;

    window[name] = data => {
      answered = true;
      cleanup();
      try { resolve(drawingData(data, id)); }
      catch (error) { reject(error); }
    };
    script.onerror = () => {
      cleanup();
      // Script errors cannot distinguish missing tags from network failures.
      reject(new Error('Could not load tag ' + id));
    };
    // A 200 error page can load without calling the JSONP callback.
    // Reject it rather than leaving the promise pending.
    script.onload = () => {
      if (answered) return;
      cleanup();
      reject(new Error('Tag ' + id + ' did not return drawing data'));
    };
    script.src = API + encodeURIComponent(id) + '.json?callback=' + name;
    document.body.appendChild(script);
  });
}

// Standalone embeds default to bundled #161, even when explicitly requested.
// Other numeric IDs use the API. Keep URL selection and the offline source here.
export async function loadEmbedTag() {
  const requested = new URLSearchParams(document.location.search).get('id');
  if (requested !== null && !/^\d+$/.test(requested)) {
    throw new Error('Tag ID must contain only digits');
  }
  const id = requested === null ? '161' : requested.replace(/^0+(?=\d)/, '');
  if (id !== '161') return loadTag(id);

  const response = await fetch(new URL('./embeds/tag.json', import.meta.url));
  if (!response.ok) throw new Error('Could not load tag 161: HTTP ' + response.status);
  return drawingData(await response.json(), id);
}
