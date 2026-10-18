# 格式及发现入口核验

2026-10-18运行官方quick_validate.py，退出码0，输出`Skill is valid!`。它只证明基本frontmatter和命名格式有效，不证明实际提速。

另行读取YAML和文件确认：SKILL.md共54行、2062字符；UI显示名Pace 提效、简述32字符、默认提示词包含$pace；未关闭默认自动发现；goal-work中的Pace链接目标存在。Skill仅含SKILL.md与agents/openai.yaml两份文件，没有常驻执行器、调度服务或业务副作用脚本。
