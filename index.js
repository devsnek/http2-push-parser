const fs = require('fs');
const { Module } = require('vm');
const { createSecureServer } = require('http2');
const path = require('path');
const mimes = require('mime-types');
const parse5 = require('parse5');

const readSync = (p) => fs.readFileSync(require.resolve(p));

const server = createSecureServer({
  cert: readSync('./localhost-cert.pem'),
  key: readSync('./localhost-privkey.pem'),
});

const absRe = /^https?:\/\//i;
const cache = Object.create(null);
const files = fs.readdirSync('./public');
for (const file of files) {
  const c = cache[`/${file}`] = {
    source: fs.readFileSync(path.resolve('./public', file), 'utf8'),
    contentType: mimes.contentType(path.extname(file)),
    deps: [],
  };
  if (c.contentType.includes('application/javascript')) {
    c.deps.push(...new Module(c.source).dependencySpecifiers);
  } else if (c.contentType.includes('text/html')) {
    const ast = parse5.parseFragment(c.source);
    (function walk(obj) {
      if (!obj.childNodes)
        return;

      for (const node of obj.childNodes) {
        switch (node.nodeName) {
          case 'script':
          case 'img': {
            const src = node.attrs.find((a) => a.name === 'src');
            if (src && src.value && !absRe.test(src.value))
              c.deps.push(src.value);
            break;
          }
          case 'link': {
            const link = node.attrs.find((a) => a.name === 'link');
            if (link && link.value && !absRe.test(link.value))
              c.deps.find(link.value);
            break;
          }
        }
        walk(node);
      }
    }(ast));
  }
}

server.on('stream', (stream, headers) => {
  const METHOD = headers[':method'];
  let PATH = headers[':path'];

  console.log(METHOD, PATH);

  if (PATH === '/')
    PATH = '/index.html';

  if (PATH in cache) {
    const hit = cache[PATH];
    hit.deps.map(push);
    stream.respond({ ':status': 200, 'Content-Type': hit.contentType });
    stream.end(hit.source);
  } else {
    stream.respond({ ':status': 404, 'Content-Type': 'text/plain; charset=UTF-8' });
    stream.end('400');
  }

  function push(p) {
    if (!(p in cache))
      return;
    console.log('PUSH', p);
    const hit = cache[p];
    hit.deps.map(push);
    stream.pushStream({ ':path': p }, (err, s) => {
      if (err) {
        s.respond({ ':status': 500, 'Content-Type': 'text/plain; charset=UTF-8' });
        s.end('500');
        return;
      }
      s.respond({ ':status': 200, 'Content-Type': hit.contentType });
      s.end(hit.source);
    });
  }
});

server.listen(8080);
