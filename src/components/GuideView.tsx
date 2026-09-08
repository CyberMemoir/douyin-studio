import { ExternalLink, Monitor, Search, Download } from 'lucide-react';
import { Button } from './ui';

export function GuideView({ onLogin }: { onLogin: () => void }) {
  return (
    <>
      <div className="page-intro">
        <h1>从第一次搜索开始。</h1>
        <p>一个本地工作台，三个简单步骤。</p>
      </div>
      <section className="panel guide-panel">
        {[
          {
            icon: Monitor,
            title: '连接并登录抖音',
            text: '点击“打开扫码登录”，在弹出的自动化 Chrome 中登录自己的账号。随后回到这里，点击“检查连接”。登录数据只保存在本机的专用浏览器配置中。',
          },
          {
            icon: Search,
            title: '搜索视频，发现热点',
            text: '输入关键词搜索，或粘贴包含抖音分享链接的整段文字。点击“获取热榜”读取抖音当前提供的热点，点选话题即可搜索相关视频。结果可以导出为 JSON。',
          },
          {
            icon: Download,
            title: '选中内容，保存到本地',
            text: '单条下载或勾选多个视频加入队列。在下载中心查看实时字节进度、取消未完成任务、重试失败任务、预览或另存已完成的视频。',
          },
        ].map(({ icon: Icon, title, text }, index) => (
          <article className="guide-step" key={title}>
            <span className="guide-number">0{index + 1}</span>
            <div>
              <h2>
                <Icon size={21} />
                {title}
              </h2>
              <p>{text}</p>
              {index === 0 && (
                <Button onClick={onLogin}>
                  打开扫码登录
                  <ExternalLink size={16} />
                </Button>
              )}
            </div>
          </article>
        ))}
      </section>
      <section className="guide-notes">
        <h2>使用边界</h2>
        <p>
          这是本地工具，不是云端下载站。运行期间请保持电脑和后台服务开启。使用自己的账号访问内容；仅下载你拥有权利或已获授权保存的作品。
        </p>
        <p>
          支持页面公开给当前会话的 MP4
          视频流；图文、直播、DRM、付费内容和分段加密流不在第一版支持范围内。不会移除水印或绕过登录、验证码、下载权限。遇到验证请在抖音窗口完成后重试。
        </p>
        <p>
          搜索和热榜来自实际页面返回，不承诺固定数量。抖音页面变动可能影响提取；失败时会提供日志，不会替换成演示结果。
        </p>
        <a
          href="https://github.com/CyberMemoir/douyin-studio"
          target="_blank"
          rel="noreferrer"
          className="text-link"
        >
          项目源码与说明 <ExternalLink size={16} />
        </a>
      </section>
    </>
  );
}
