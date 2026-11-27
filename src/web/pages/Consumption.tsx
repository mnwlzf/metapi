import { Link } from 'react-router-dom';
import ConsumptionPanel from './consumption/ConsumptionPanel.js';

export default function Consumption() {
  return <div className="animate-fade-in"><div className="page-header"><h2 className="page-title">消费分析</h2><Link to="/">返回仪表盘</Link></div><ConsumptionPanel /></div>;
}
