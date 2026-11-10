-- 新上传文件的图片价值判断标记；历史文件默认不触发逐图判断。
ALTER TABLE ai_distill.library_files
  ADD COLUMN image_review_required boolean NOT NULL DEFAULT false;
