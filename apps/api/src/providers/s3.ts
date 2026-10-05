import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider } from './types.js';

const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const b64ToHex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

export class S3StorageProvider implements StorageProvider {
  private readonly s3: S3Client;
  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string; forcePathStyle?: boolean },
  ) {
    this.s3 = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle });
  }

  async presignUpload(i: { key: string; contentType: string; sizeBytes: number; sha256Hex: string; expiresSec: number }) {
    const checksum = hexToB64(i.sha256Hex);
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: i.key,
      ContentType: i.contentType,
      ContentLength: i.sizeBytes,
      ChecksumSHA256: checksum,
    });
    // S3 rejects the upload if the body's SHA-256 differs from the declared one.
    const url = await getSignedUrl(this.s3, cmd, {
      expiresIn: i.expiresSec,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
    });
    return {
      url,
      headers: { 'content-type': i.contentType, 'x-amz-checksum-sha256': checksum },
    };
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      return {
        sizeBytes: Number(r.ContentLength ?? 0),
        sha256Hex: r.ChecksumSHA256 ? b64ToHex(r.ChecksumSHA256) : undefined,
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  presignDownload(key: string, expiresSec: number) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSec });
  }
}
