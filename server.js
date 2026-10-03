const express = require("express");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36";

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(
  "/hls",
  express.static(
    path.join(__dirname, "node_modules", "hls.js", "dist")
  )
);


/* =========================================================
   HELPERS
========================================================= */

function validURL(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}


function absoluteURL(value, baseURL) {
  try {
    return new URL(value, baseURL).href;
  } catch {
    return value;
  }
}


function proxyURL(url, ua = "", referer = "") {
  const params = new URLSearchParams();

  params.set("url", url);

  if (ua) {
    params.set("ua", ua);
  }

  if (referer) {
    params.set("referer", referer);
  }

  return "/stream?" + params.toString();
}


function upstreamHeaders(req) {
  const headers = {
    "User-Agent":
      req.query.ua || DEFAULT_UA,

    "Accept":
      "application/vnd.apple.mpegurl, application/x-mpegURL, video/*, audio/*, */*",

    "Accept-Language":
      "en-US,en;q=0.9",

    "Cache-Control":
      "no-cache",

    "Pragma":
      "no-cache"
  };


  if (req.query.referer) {
    headers["Referer"] =
      req.query.referer;
  }


  if (req.headers.range) {
    headers["Range"] =
      req.headers.range;
  }


  return headers;
}


/* =========================================================
   HLS MANIFEST REWRITER
========================================================= */

function rewriteManifest(
  manifest,
  finalManifestURL,
  ua,
  referer
) {

  const lines =
    manifest.split(/\r?\n/);


  return lines.map(line => {

    const trimmed =
      line.trim();


    if (!trimmed) {
      return line;
    }


    /*
      URI="..."
      Handles:
      EXT-X-KEY
      EXT-X-MAP
      EXT-X-MEDIA
      EXT-X-I-FRAME-STREAM-INF
      etc.
    */

    if (trimmed.startsWith("#")) {

      return line.replace(
        /URI=(["'])(.*?)\1/gi,
        (match, quote, uri) => {

          const absolute =
            absoluteURL(
              uri,
              finalManifestURL
            );


          const proxied =
            proxyURL(
              absolute,
              ua,
              referer
            );


          return (
            "URI=" +
            quote +
            proxied +
            quote
          );
        }
      );
    }


    /*
      Normal HLS lines:
      child.m3u8
      segment.ts
      segment.m4s
      init.mp4
      etc.
    */

    const absolute =
      absoluteURL(
        trimmed,
        finalManifestURL
      );


    return proxyURL(
      absolute,
      ua,
      referer
    );

  }).join("\n");
}


/* =========================================================
   PLAYLIST LOADER
========================================================= */

app.get("/playlist", async (req, res) => {

  const target =
    req.query.url;


  if (
    !target ||
    !validURL(target)
  ) {

    return res
      .status(400)
      .send(
        "Invalid playlist URL"
      );
  }


  try {

    const response =
      await fetch(target, {

        method: "GET",

        redirect: "follow",

        headers: {
          "User-Agent":
            DEFAULT_UA,

          "Accept":
            "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*",

          "Cache-Control":
            "no-cache"
        }
      });


    if (!response.ok) {

      return res
        .status(response.status)
        .send(
          "Playlist source returned HTTP " +
          response.status
        );
    }


    const text =
      await response.text();


    res.setHeader(
      "Content-Type",
      "text/plain; charset=utf-8"
    );


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    return res.send(text);


  } catch (error) {

    console.error(
      "PLAYLIST ERROR:",
      error
    );


    return res
      .status(502)
      .send(
        "Playlist connection failed"
      );
  }
});


/* =========================================================
   STREAM PROXY
========================================================= */

app.get("/stream", async (req, res) => {

  const target =
    req.query.url;


  if (
    !target ||
    !validURL(target)
  ) {

    return res
      .status(400)
      .send(
        "Invalid stream URL"
      );
  }


  try {

    /*
      IMPORTANT:

      redirect: follow

      Example:

      original.m3u8
           |
           | 302
           v
      signed/master.m3u8?token=...

      response.url becomes the FINAL signed URL.
    */

    const response =
      await fetch(target, {

        method: "GET",

        redirect: "follow",

        headers:
          upstreamHeaders(req)
      });


    const finalURL =
      response.url || target;


    console.log(
      "[" +
      response.status +
      "]",
      target,
      "=>",
      finalURL
    );


    if (
      !response.ok &&
      response.status !== 206
    ) {

      return res
        .status(response.status)
        .send(
          "Source server returned HTTP " +
          response.status
        );
    }


    const contentType =
      (
        response.headers.get(
          "content-type"
        ) || ""
      ).toLowerCase();


    /*
      Detect HLS from BOTH:
      content-type + final redirected URL
    */

    const isHLS =
      contentType.includes(
        "mpegurl"
      ) ||

      contentType.includes(
        "m3u"
      ) ||

      /\.m3u8?(?:$|[?#])/i.test(
        finalURL
      );


    if (isHLS) {

      const manifest =
        await response.text();


      /*
        CRITICAL FIX:

        Rewrite relative paths against response.url,
        NOT against the original redirect URL.
      */

      const rewritten =
        rewriteManifest(
          manifest,
          finalURL,
          req.query.ua || "",
          req.query.referer || ""
        );


      res.status(200);


      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );


      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );


      res.setHeader(
        "Pragma",
        "no-cache"
      );


      return res.send(
        rewritten
      );
    }


    /*
      MEDIA SEGMENTS / MP4 / TS / AAC / M4S
    */

    const headersToForward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "etag",
      "last-modified"
    ];


    for (
      const headerName
      of headersToForward
    ) {

      const value =
        response.headers.get(
          headerName
        );


      if (value) {

        res.setHeader(
          headerName,
          value
        );
      }
    }


    res.status(
      response.status
    );


    if (!response.body) {

      return res.end();
    }


    const stream =
      Readable.fromWeb(
        response.body
      );


    stream.on(
      "error",
      error => {

        console.error(
          "PIPE ERROR:",
          error.message
        );


        if (!res.destroyed) {
          res.destroy();
        }
      }
    );


    req.on(
      "close",
      () => {

        try {
          stream.destroy();
        } catch {}
      }
    );


    stream.pipe(res);


  } catch (error) {

    console.error(
      "STREAM ERROR:",
      error
    );


    if (!res.headersSent) {

      return res
        .status(502)
        .send(
          "Stream connection failed: " +
          error.message
        );
    }


    try {
      res.end();
    } catch {}
  }
});


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/health", (req, res) => {

  res.json({
    ok: true,
    player: "Premium IPTV",
    version: "5.0"
  });
});


/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {

  console.log("");
  console.log(
    "======================================"
  );

  console.log(
    " PREMIUM IPTV PLAYER V5"
  );

  console.log(
    " http://localhost:" + PORT
  );

  console.log(
    " Redirect/HLS proxy: READY"
  );

  console.log(
    "======================================"
  );

  console.log("");
});


