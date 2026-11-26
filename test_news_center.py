import unittest
from datetime import timedelta
from news_center_engine import item, now, dedup, candidates, safe_link

class NewsTests(unittest.TestCase):
    def test_duplicate_titles(self):
        a=item("[속보] 삼성전자 반도체 대규모 공급계약 체결","https://example.org/a","a","증권","언론",now().timestamp(),"20261127")
        b=item("삼성전자 반도체 대규모 공급계약 체결","https://example.org/b","b","증권","언론",now().timestamp(),"20261127")
        result=dedup([a,b])
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]["duplicates"],2)
        self.assertIn("반도체",result[0]["themes"])

    def test_alert_rights_and_time(self):
        current=now()
        stamp=current.timestamp()
        day=current.strftime("%Y%m%d")
        media=item("삼성전자 공급계약","https://example.org/m","m","증권","언론",stamp,day)
        dart=item("삼성전자 단일판매ㆍ공급계약체결","https://example.org/d","DART","공시","공시",date=day,code="005930")
        stale=item("거래정지","https://example.org/o","DART","공시","공시",date=(current-timedelta(days=1)).strftime("%Y%m%d"))
        self.assertEqual(candidates([media,dart,stale],4,"005930"),[dart])
        self.assertEqual(candidates([media,dart,stale],4),[dart])
        self.assertIsNone(dart["stamp"])

    def test_links(self):
        self.assertEqual(safe_link("javascript:alert(1)"),"")
        self.assertEqual(safe_link("https://example.org"),"https://example.org")

if __name__=="__main__":
    unittest.main()
