import { GitBranch, Globe, Monitor, MapPin, Construction } from "lucide-react";

const ROUTING_FEATURES = [
  {
    icon: <Monitor className="w-5 h-5 text-indigo-400" />,
    title: "По процессам",
    description: "Выбирайте, какие приложения идут через VPN",
  },
  {
    icon: <Globe className="w-5 h-5 text-emerald-400" />,
    title: "По доменам",
    description: "Настройте маршруты для конкретных сайтов",
  },
  {
    icon: <MapPin className="w-5 h-5 text-amber-400" />,
    title: "По IP-адресам",
    description: "Управляйте маршрутами по IP и подсетям (CIDR)",
  },
];

function RoutingPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
          <GitBranch className="w-7 h-7 text-indigo-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-200">
            Маршрутизация
          </h2>
          <p className="text-xs text-gray-500">
            Гибкое управление трафиком
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-lg w-full">
        {ROUTING_FEATURES.map((f) => (
          <div
            key={f.title}
            className="glass-card p-4 flex flex-col items-center gap-2 text-center opacity-60"
          >
            {f.icon}
            <span className="text-xs font-medium text-gray-300">
              {f.title}
            </span>
            <span className="text-[10px] text-gray-500">{f.description}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-gray-500">
        <Construction className="w-4 h-4" />
        <span className="text-xs">В разработке — скоро будет доступно</span>
      </div>
    </div>
  );
}

export default RoutingPanel;
