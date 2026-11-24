// Replace each <div class="figph" data-src="..."> with the image once that file exists.
// To add a paper figure, save it under figures/ with the name shown on the placeholder.
document.querySelectorAll('.figph[data-src]').forEach((ph) => {
  const img = new Image();
  img.className = 'paperfig';
  img.alt = ph.dataset.alt || ph.dataset.src;
  img.onload = () => {
    const fig = document.createElement('figure');
    fig.className = 'paperfig-wrap';
    fig.appendChild(img);
    if (ph.dataset.caption) {
      const cap = document.createElement('figcaption');
      cap.className = 'src';
      cap.textContent = ph.dataset.caption;
      fig.appendChild(cap);
    }
    ph.replaceWith(fig);
  };
  img.src = ph.dataset.src;
});
