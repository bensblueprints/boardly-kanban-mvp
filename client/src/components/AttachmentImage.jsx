import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AttachmentImage({ src, ...props }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let objectUrl;
    setUrl('');
    api.blob(src, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => {});
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src]);
  return url ? <img {...props} src={url} /> : <span aria-label="Image attachment" className={props.className} />;
}
