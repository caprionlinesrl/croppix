import url from 'url';
import fs from 'fs';
import http from 'http';
import https from 'https';
import sharp from 'sharp';
import smartcrop from 'smartcrop-sharp';
import FilesystemCache from 'node-filesystem-cache';

export const processImageWithCache = async (imageUrl, options) => {
  const cache = new FilesystemCache(options.cacheDir);
  const result = cache.get(imageUrl);

  if (result !== null) {
    return result;
  }

  const processedImage = await processImage(imageUrl, options);
  cache.put(imageUrl, processedImage);

  return processedImage;
};

export const processImage = async (imageUrl, options) => {
  const parsedUrl = parseUrl(imageUrl);
  const imageData = await loadImage(parsedUrl, options);
  const imageOptions = await parseImageOptions(parsedUrl, imageData, options);

  if (imageOptions.original) {
    return await parseOriginal(imageData, imageOptions);
  } else if (imageOptions.crop === 'smart') {
    return await parseCropSmart(imageData, imageOptions);
  } else if (imageOptions.crop === 'none') {
    return await parseCropNone(imageData, imageOptions);
  } else {
    return await parseCropOther(imageData, imageOptions);
  }
};

const parseUrl = (imageUrl) => {
  const parsedUrl = url.parse(imageUrl);
  parsedUrl.pathname = decodeURI(parsedUrl.pathname);

  return parsedUrl;
};

const loadImage = async (parsedUrl, options) => {
  const isRemote = parsedUrl.pathname.startsWith('/http:') || parsedUrl.pathname.startsWith('/https:');

  if (isRemote) {
    const remoteImageUrl = parsedUrl.pathname.substr(1);
    const protocol = remoteImageUrl.startsWith('https') ? https : http;

    return new Promise((resolve, reject) => {
      protocol.get(remoteImageUrl, (response) => {
        const data = [];

        response.on('data', (chunk) => {
          data.push(chunk);
        });

        response.on('end', () => {
          resolve(Buffer.concat(data));
        });

        response.on('error', (err) => {
          reject(err);
        });
      }).on('error', (err) => {
        reject(err);
      });
    });
  } else {
    const imagePath = `${options.baseDir}${parsedUrl.pathname}`;
    return fs.promises.readFile(imagePath);
  }
};

const parseImageOptions = async (parsedUrl, imageData, options) => {
  const result = {
    path: parsedUrl.pathname,
    width: 0,
    height: 0,
    shortSide: 0,
    longSide: 0,
    format: '',
    crop: 'smart',
    cropSmartBoost: '',
    quality: 'optimized',
    density: 1.0,
    original: false
  };

  const formats = ['jpeg', 'png', 'webp'];

  const crops = [
    'smart', 'entropy', 'attention', 'center', 'top', 'rightTop', 'right',
    'rightBottom', 'bottom', 'leftBottom', 'left', 'leftTop', 'none',
  ];

  const qualities = ['optimized', 'balanced', 'high'];

  const image = sharp(imageData);
  const metadata = await image.metadata();
  result.format = metadata.format;

  if (parsedUrl.query) {
    parsedUrl.query.split('&').forEach((arg) => {
      const [name, value] = arg.split('=');

      if (['width', 'height', 'shortSide', 'longSide'].includes(name)) {
        const intValue = parseInt(value);
        if (intValue > 0 && intValue < 5000) {
          result[name] = intValue;
        }
      } else if (name === 'format' && formats.includes(value)) {
        result.format = value;
      } else if (name === 'crop' && crops.includes(value)) {
        result.crop = value;
      } else if (name === 'cropSmartBoost') {
        const boost = value.split(',');

        result.cropSmartBoost = [{
          x: boost[0] ?? 0,
          y: boost[1] ?? 0,
          width: boost[2] ?? 0,
          height: boost[3] ?? 0,
          weight: 1
        }];
      } else if (name === 'quality' && qualities.includes(value)) {
        result.quality = value;
      } else if (name === 'density') {
        const densityValue = parseFloat(value);

        if (densityValue >= 1.0 && densityValue <= 3.0) {
          result.density = densityValue;
        }
      }
    });
  } else {
    result.original = true;
  }

  if (result.shortSide > 0) {
    if (metadata.width < metadata.height) {
      result.width = result.shortSide;
    } else {
      result.height = result.shortSide;
    }
  } else if (result.longSide > 0) {
    if (metadata.width > metadata.height) {
      result.width = result.longSide;
    } else {
      result.height = result.longSide;
    }
  }

  if (result.width === 0 && result.height === 0) {
    result.width = metadata.width;
    result.height = metadata.height;
  } else if (result.width > 0 && result.height === 0) {
    result.height = parseInt((result.width * metadata.height) / metadata.width);
  } else if (result.width === 0 && result.height > 0) {
    result.width = parseInt((result.height * metadata.width) / metadata.height);
  }

  result.width = result.width ? parseInt(result.width * result.density) : result.width;
  result.height = result.height ? parseInt(result.height * result.density) : result.height;
  result.shortSide = result.shortSide ? parseInt(result.shortSide * result.density) : result.shortSide;
  result.longSide = result.longSide ? parseInt(result.longSide * result.density) : result.longSide;

  return result;
};

const parseOriginal = async (imageData, imageOptions) => {
  return { imageData, imageOptions };
};

const parseCropSmart = async (imageData, imageOptions) => {
  const size = { width: imageOptions.width, height: imageOptions.height };
  const cropResult = await smartcrop.crop(imageData, size);

  const image = sharp(imageData)
    .extract({
      width: cropResult.topCrop.width,
      height: cropResult.topCrop.height,
      left: cropResult.topCrop.x,
      top: cropResult.topCrop.y
    })
    .resize(size);

  return await finalize(image, imageOptions);
};

const parseCropNone = async (imageData, imageOptions) => {
  const image = sharp(imageData);
  const { channels: [rc, gc, bc] } = await image.stats();

  image.resize({
    width: imageOptions.width,
    height: imageOptions.height,
    fit: 'contain',
    background: {
      r: Math.round(rc.mean),
      g: Math.round(gc.mean),
      b: Math.round(bc.mean),
      alpha: 1
    }
  });

  return await finalize(image, imageOptions);
};

const parseCropOther = async (imageData, imageOptions) => {
  const image = sharp(imageData);

  image.resize({
    width: imageOptions.width,
    height: imageOptions.height,
    position: getPosition(imageOptions.crop)
  });

  return await finalize(image, imageOptions);
};

const getPosition = (pos) => {
  if (pos === 'entropy') {
    return sharp.strategy.entropy;
  } else if (pos === 'attention') {
    return sharp.strategy.attention;
  } else {
    return pos.split(/(?=[A-Z])/).join(' ').toLowerCase();
  }
};

const finalize = async (image, imageOptions) => {
  optimize(image, imageOptions);
  const imageData = await image.toBuffer();

  return { imageData, imageOptions };
};

const optimize = (image, imageOptions) => {
  optimizeSharpen(image);

  if (imageOptions.format === 'png') {
    optimizePng(image);
  } else if (imageOptions.format === 'webp') {
    optimizeWebp(image);
  } else {
    optimizeJpeg(image, imageOptions);
  }
};

const optimizeSharpen = (image) => {
  image.sharpen({ sigma: 0.5 });
};

const optimizeJpeg = (image, imageOptions) => {
  let quality;

  if (imageOptions.quality === 'optimized') {
    quality = 70;
  } else if (imageOptions.quality === 'balanced') {
    quality = 80;
  } else {
    quality = 88;
  }

  image.jpeg({ quality, mozjpeg: imageOptions.quality === 'optimized' });
};

const optimizeWebp = (image) => {
  image.webp();
};

const optimizePng = (image) => {
  image.png();
};
