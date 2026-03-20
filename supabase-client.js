import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.0/+esm';
import { S3Client, PutObjectCommand } from 'https://cdn.jsdelivr.net/npm/@aws-sdk/client-s3@3.888.0/+esm';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const AWS_REGION = import.meta.env.VITE_AWS_REGION;
const AWS_BUCKET = import.meta.env.VITE_AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = import.meta.env.VITE_AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing Supabase credentials in .env file');
}

const hasAwsStorageConfig = Boolean(
  AWS_REGION && AWS_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
);

if (!hasAwsStorageConfig) {
  console.warn(
    'AWS S3 storage is not configured. Falling back to Supabase Storage for image uploads.'
  );
}

const s3Client = hasAwsStorageConfig
  ? new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY
      }
    })
  : null;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getCurrentUserId() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id;
}

function getSafeExtension(fileName = '') {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext || ext === fileName) return 'jpg';
  return ext.replace(/[^a-z0-9]/g, '');
}

function buildImagePath(userId, folder, file) {
  const fileExt = getSafeExtension(file?.name);
  const fileId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return `${folder}/${userId}/${fileId}.${fileExt}`;
}

function getS3PublicUrl(path) {
  return `https://${AWS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${path}`;
}

async function uploadImageToAwsS3(file, path) {
  if (!s3Client) {
    throw new Error('AWS S3 is not configured');
  }

  const command = new PutObjectCommand({
    Bucket: AWS_BUCKET,
    Key: path,
    Body: file,
    ContentType: file.type || 'application/octet-stream'
  });

  await s3Client.send(command);
  return getS3PublicUrl(path);
}

async function uploadImageToSupabaseStorage(file, path, bucket) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: false });

  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage
    .from(bucket)
    .getPublicUrl(path);

  return publicUrl;
}

export async function uploadImage(file, options = {}) {
  const {
    folder = 'posts',
    supabaseBucket = 'posts-images'
  } = options;

  const userId = await getCurrentUserId();
  if (!userId) throw new Error('User not authenticated');

  const imagePath = buildImagePath(userId, folder, file);

  if (hasAwsStorageConfig) {
    return uploadImageToAwsS3(file, imagePath);
  }

  return uploadImageToSupabaseStorage(file, imagePath, supabaseBucket);
}

export async function uploadProfileImage(file) {
  return uploadImage(file, {
    folder: 'avatars',
    supabaseBucket: 'user-avatars'
  });
}
