-- 正文插入事件不再反查后续的任务成功状态；057的任务成功门禁已统一校验正文数。
DROP TRIGGER library_documents_complete ON ai_distill.library_documents;
DROP FUNCTION ai_distill.validate_library_documents_complete();
