/** 本地OFD整页转PDF入口；由材料预处理调用，读取原件、写PDF，不调用网络或数据库。 */
import java.nio.file.*;
import org.ofdrw.reader.OFDReader;
import org.ofdrw.converter.export.PDFExporterIText;
public class OfdToPdf {
 public static void main(String[] args) throws Exception {
  if(args.length!=2)throw new IllegalArgumentException("usage: OfdToPdf input.ofd output.pdf");
  Path source=Paths.get(args[0]),target=Paths.get(args[1]);
  int pages;try(OFDReader reader=new OFDReader(source)){pages=reader.getNumberOfPages();}
  try(PDFExporterIText exporter=new PDFExporterIText(source,target)){exporter.export();}
  System.out.println("DISTILL_OFD_PAGES="+pages);
 }
}
